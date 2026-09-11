--!strict
--[[
	Watcher — change tracking, scoped to what VS Code is actually looking at.

	The plugin never walks the DataModel. VS Code subscribes to a node when the user
	expands it, and that subscription is what installs listeners:

	  * ChildAdded / ChildRemoved on the node itself  -> childAdded / childRemoved
	  * Name changed on each child                    -> nodeChanged
	  * ChildAdded / ChildRemoved on each child       -> nodeChanged (twisty appears
	                                                     or disappears when the child's
	                                                     own child count crosses zero)

	Collapse the node in VS Code and every one of those connections goes away, so an
	idle session costs nothing regardless of place size.
]]

local Config = require(script.Parent.Config)
local Log = require(script.Parent.Log)
local Registry = require(script.Parent.Registry)
local Serializer = require(script.Parent.Serializer)

local Watcher = {}
Watcher.__index = Watcher

-- TextDocumentDidChange fires on every keystroke; VS Code only needs to know that the
-- file moved on, not how many times.
local SOURCE_THROTTLE = 0.75

export type Emit = (event: { [string]: any }) -> ()

type Subscription = {
	instance: Instance,
	connections: { RBXScriptConnection },
	childConnections: { [Instance]: { RBXScriptConnection } },
	perChild: boolean,
}

export type Watcher = typeof(setmetatable(
	{} :: {
		emit: Emit,
		subscriptions: { [string]: Subscription },
		sourceWatches: { [string]: { RBXScriptConnection } },
		globalConnections: { RBXScriptConnection },
		suppressSelectionEcho: boolean,
	},
	Watcher
))

function Watcher.new(emit: Emit): Watcher
	local self = setmetatable({
		emit = emit,
		subscriptions = {},
		sourceWatches = {},
		globalConnections = {},
		suppressSelectionEcho = false,
	}, Watcher)
	return (self :: any) :: Watcher
end

--- Mirrors Studio's selection into VS Code. Guarded by `suppressSelectionEcho` so that
--- a selection VS Code just requested does not bounce straight back at it.
function Watcher.startSelectionMirror(self: Watcher)
	local selection = game:GetService("Selection")
	table.insert(
		self.globalConnections,
		selection.SelectionChanged:Connect(function()
			if self.suppressSelectionEcho then
				return
			end
			local refs = {}
			local paths = {}
			for _, instance in ipairs(selection:Get()) do
				refs[#refs + 1] = Registry.refFor(instance)
				-- Segments, not a dotted string: VS Code has to walk this path node by
				-- node to reveal the row, and a name containing a dot would otherwise
				-- split into two segments that match nothing.
				paths[#paths + 1] = Serializer.pathSegments(instance)
			end
			self.emit({ type = "selectionChanged", refs = refs, paths = paths })
		end)
	)
end

local function disconnectChild(subscription: Subscription, child: Instance)
	local connections = subscription.childConnections[child]
	if not connections then
		return
	end
	for _, connection in ipairs(connections) do
		connection:Disconnect()
	end
	subscription.childConnections[child] = nil
end

local function watchChild(self: Watcher, subscription: Subscription, child: Instance)
	if not subscription.perChild or subscription.childConnections[child] then
		return
	end

	local function announce()
		-- The instance may have been destroyed between the signal firing and this
		-- running; a stale ref means VS Code already heard about the removal.
		if not child:IsDescendantOf(game) then
			return
		end
		local ok, node = pcall(Serializer.node, child)
		if ok then
			self.emit({ type = "nodeChanged", node = node })
		end
	end

	local connections = {
		child:GetPropertyChangedSignal("Name"):Connect(announce),
		child.ChildAdded:Connect(announce),
		child.ChildRemoved:Connect(announce),
	}

	if child:IsA("Script") or child:IsA("LocalScript") then
		local ok, signal = pcall(function()
			return child:GetPropertyChangedSignal("Disabled")
		end)
		if ok then
			connections[#connections + 1] = signal:Connect(announce)
		end
	end

	subscription.childConnections[child] = connections
end

--- Starts watching `instance`. Idempotent: re-subscribing an already-watched ref is a
--- no-op, which lets VS Code subscribe freely on every expand.
function Watcher.subscribe(self: Watcher, ref: string, instance: Instance)
	if self.subscriptions[ref] then
		return
	end

	local childCount = #instance:GetChildren()
	local perChild = childCount <= Config.PER_CHILD_LISTENER_LIMIT
	if not perChild then
		Log.debug(
			string.format(
				"%s has %d children; watching at parent level only",
				Serializer.fullPath(instance),
				childCount
			)
		)
	end

	local subscription: Subscription = {
		instance = instance,
		connections = {},
		childConnections = {},
		perChild = perChild,
	}
	self.subscriptions[ref] = subscription

	table.insert(
		subscription.connections,
		instance.ChildAdded:Connect(function(child)
			watchChild(self, subscription, child)
			local ok, node = pcall(Serializer.node, child)
			if ok then
				self.emit({
					type = "childAdded",
					parent = ref,
					node = node,
					index = table.find(instance:GetChildren(), child) or -1,
				})
			end
		end)
	)

	table.insert(
		subscription.connections,
		instance.ChildRemoved:Connect(function(child)
			disconnectChild(subscription, child)
			-- Only announce children VS Code has actually seen.
			local childRef = Registry.existingRef(child)
			if childRef then
				Registry.forget(child)
				self.emit({ type = "childRemoved", parent = ref, ref = childRef })
			end
		end)
	)

	-- The node's own name matters too: it is a row in its parent's list.
	table.insert(
		subscription.connections,
		instance:GetPropertyChangedSignal("Name"):Connect(function()
			local ok, node = pcall(Serializer.node, instance)
			if ok then
				self.emit({ type = "nodeChanged", node = node })
			end
		end)
	)

	for _, child in ipairs(instance:GetChildren()) do
		watchChild(self, subscription, child)
	end
end

function Watcher.unsubscribe(self: Watcher, ref: string)
	local subscription = self.subscriptions[ref]
	if not subscription then
		return
	end
	for _, connection in ipairs(subscription.connections) do
		connection:Disconnect()
	end
	for child in pairs(subscription.childConnections) do
		disconnectChild(subscription, child)
	end
	self.subscriptions[ref] = nil
end

--- Watches a script's Source so an open VS Code editor can refresh itself. Separate
--- from tree subscriptions: opening a script does not mean its parent is expanded.
---
--- Two signals, because neither is sufficient alone. `Source` changing covers edits
--- made from outside the editor (a plugin, an undo, Script Sync writing a file in),
--- but lags while the script is open in Studio. TextDocumentDidChange covers the open
--- case, and fires per keystroke — hence the throttle.
function Watcher.watchSource(self: Watcher, ref: string, instance: Instance)
	if self.sourceWatches[ref] then
		return
	end

	local connections: { RBXScriptConnection } = {}
	local lastAnnounced = 0

	local function announce()
		local now = os.clock()
		if now - lastAnnounced < SOURCE_THROTTLE then
			return
		end
		lastAnnounced = now
		self.emit({ type = "sourceChanged", ref = ref })
	end

	local okSignal, signal = pcall(function()
		return instance:GetPropertyChangedSignal("Source")
	end)
	if okSignal then
		connections[#connections + 1] = signal:Connect(announce)
	end

	local okEditor, editorConnection = pcall(function()
		return game:GetService("ScriptEditorService").TextDocumentDidChange:Connect(function(document)
			local okScript, scriptRef = pcall(function()
				return document:GetScript()
			end)
			if okScript and scriptRef == instance then
				announce()
			end
		end)
	end)
	if okEditor then
		connections[#connections + 1] = editorConnection
	end

	if #connections == 0 then
		return
	end
	self.sourceWatches[ref] = connections
end

function Watcher.unwatchSource(self: Watcher, ref: string)
	local connections = self.sourceWatches[ref]
	if connections then
		for _, connection in ipairs(connections) do
			connection:Disconnect()
		end
		self.sourceWatches[ref] = nil
	end
end

--- Applies a selection from VS Code without echoing it back as a selectionChanged
--- event. The flag is cleared on the next frame because SelectionChanged fires
--- asynchronously.
function Watcher.applySelection(self: Watcher, instances: { Instance })
	local selection = game:GetService("Selection")
	self.suppressSelectionEcho = true
	local ok, err = pcall(function()
		selection:Set(instances)
	end)
	task.defer(function()
		self.suppressSelectionEcho = false
	end)
	if not ok then
		Log.debug("selection failed:", err)
	end
end

function Watcher.subscriptionCount(self: Watcher): number
	local count = 0
	for _ in pairs(self.subscriptions) do
		count += 1
	end
	return count
end

function Watcher.destroy(self: Watcher)
	for ref in pairs(self.subscriptions) do
		Watcher.unsubscribe(self, ref)
	end
	for ref in pairs(self.sourceWatches) do
		Watcher.unwatchSource(self, ref)
	end
	for _, connection in ipairs(self.globalConnections) do
		connection:Disconnect()
	end
	self.globalConnections = {}
end

return Watcher
