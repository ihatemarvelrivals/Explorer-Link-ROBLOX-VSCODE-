--!strict
--[[
	Commands — one handler per command type in PROTOCOL.md.

	Handlers return a plain table on success or `error("message")` on failure; the
	transport wraps whichever happens into a `result` event carrying the command id.
]]

local Log = require(script.Parent.Log)
local PropertySpecs = require(script.Parent.PropertySpecs)
local Registry = require(script.Parent.Registry)
local Serializer = require(script.Parent.Serializer)
local Watcher = require(script.Parent.Watcher)

local Commands = {}

--[[
	The services Studio's Explorer shows at the top level, in its order. `FindService`
	rather than `GetService` throughout, so opening the tree never has the side effect
	of creating a service that was not already in the place.
]]
local ROOT_SERVICES = {
	"Workspace",
	"Players",
	"Lighting",
	"MaterialService",
	"ReplicatedFirst",
	"ReplicatedStorage",
	"ServerScriptService",
	"ServerStorage",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"Teams",
	"SoundService",
	"TextChatService",
	"Chat",
	"LocalizationService",
	"TestService",
}

--- The root row set: curated services, plus any other service that already holds
--- children so nothing in the place is invisible.
function Commands.roots(): { { [string]: any } }
	local nodes = {}
	local included: { [Instance]: boolean } = {}

	for _, name in ipairs(ROOT_SERVICES) do
		local ok, service = pcall(function()
			return game:FindService(name)
		end)
		if ok and service then
			included[service] = true
			local okNode, node = pcall(Serializer.node, service)
			if okNode then
				nodes[#nodes + 1] = node
			end
		end
	end

	for _, child in ipairs(game:GetChildren()) do
		if not included[child] then
			local okCount, children = pcall(function()
				return child:GetChildren()
			end)
			if okCount and #children > 0 then
				local okNode, node = pcall(Serializer.node, child)
				if okNode then
					nodes[#nodes + 1] = node
				end
			end
		end
	end

	return nodes
end

local function requireInstance(ref: string): Instance
	local instance = Registry.resolve(ref)
	if not instance then
		error("stale-ref", 0)
	end
	return instance
end

export type Context = {
	watcher: Watcher.Watcher,
	pluginRef: Plugin,
}

local handlers: { [string]: (Context, { [string]: any }) -> { [string]: any } } = {}

handlers.ping = function(_context, _payload)
	return { t = os.clock() }
end

handlers.getChildren = function(context, payload)
	local instance = requireInstance(payload.ref)
	-- Expanding a node is exactly when watching it starts paying for itself.
	Watcher.subscribe(context.watcher, payload.ref, instance)
	return { nodes = Serializer.children(instance) }
end

handlers.getProperties = function(_context, payload)
	local instance = requireInstance(payload.ref)
	return { groups = PropertySpecs.groupsFor(instance) }
end

handlers.getSource = function(context, payload)
	local instance = requireInstance(payload.ref)
	if not instance:IsA("LuaSourceContainer") then
		error("not-a-script", 0)
	end

	-- Roblox decoupled `Source` from the script editor: while a script is open in
	-- Studio, `Source` only catches up periodically, so reading it directly can hand
	-- back text the user edited minutes ago. GetEditorSource is the current view.
	-- It is newer than some Studio builds, hence the fall back.
	local source: string? = nil
	local okEditor, editorSource = pcall(function()
		return game:GetService("ScriptEditorService"):GetEditorSource(instance)
	end)
	if okEditor and type(editorSource) == "string" then
		source = editorSource
	else
		local okSource, rawSource = pcall(function()
			return (instance :: any).Source
		end)
		if not okSource then
			-- Inaccessible for scripts inside a locked or protected model.
			error("source-unavailable", 0)
		end
		source = rawSource
	end

	Watcher.watchSource(context.watcher, payload.ref, instance)
	return {
		source = source,
		name = instance.Name,
		className = instance.ClassName,
		path = Serializer.fullPath(instance),
	}
end

handlers.releaseSource = function(context, payload)
	Watcher.unwatchSource(context.watcher, payload.ref)
	return {}
end

handlers.subscribe = function(context, payload)
	for _, ref in ipairs(payload.refs or {}) do
		local instance = Registry.resolve(ref)
		if instance then
			Watcher.subscribe(context.watcher, ref, instance)
		end
	end
	return {}
end

handlers.unsubscribe = function(context, payload)
	for _, ref in ipairs(payload.refs or {}) do
		Watcher.unsubscribe(context.watcher, ref)
	end
	return {}
end

handlers.select = function(context, payload)
	local instances = {}
	for _, ref in ipairs(payload.refs or {}) do
		local instance = Registry.resolve(ref)
		if instance then
			instances[#instances + 1] = instance
		end
	end
	Watcher.applySelection(context.watcher, instances)
	return {}
end

handlers.revealInStudio = function(context, payload)
	local instance = requireInstance(payload.ref)
	Watcher.applySelection(context.watcher, { instance })
	-- Opening a script also brings its Studio editor tab forward, which is the closest
	-- thing the plugin API has to "scroll the Explorer to this row".
	if instance:IsA("LuaSourceContainer") then
		pcall(function()
			context.pluginRef:OpenScript(instance)
		end)
	end
	return {}
end

--- Resolves "game.Workspace.Sword.Handle" to a ref, so VS Code can restore an expanded
--- tree across a reconnect without holding stale refs.
handlers.resolvePath = function(_context, payload)
	local path = tostring(payload.path or "")
	local current: Instance? = game
	local first = true
	for segment in string.gmatch(path, "[^%.]+") do
		if first and segment == "game" then
			first = false
		else
			first = false
			if not current then
				return { ref = nil }
			end
			local ok, found = pcall(function()
				return (current :: Instance):FindFirstChild(segment)
			end)
			if not ok or not found then
				return { ref = nil }
			end
			current = found
		end
	end
	if not current then
		return { ref = nil }
	end
	return { ref = Registry.refFor(current) }
end

--[[
	Geometry for the 3D preview.

	Only primitive shape, size, position and orientation travel — a plugin cannot read
	the vertices behind a MeshPart or a union (MeshId is an asset reference, not data),
	so those report as boxes and are counted so the viewer can say so out loud rather
	than quietly drawing a lie.
]]
local SHAPE_BY_PART_TYPE: { [Enum.PartType]: string } = {
	[Enum.PartType.Ball] = "ball",
	[Enum.PartType.Cylinder] = "cylinder",
	[Enum.PartType.Block] = "box",
}

local function shapeOf(part: BasePart): (string, boolean)
	-- Order matters: MeshPart and the union operations are BaseParts too.
	if part:IsA("MeshPart") or part:IsA("UnionOperation") or part:IsA("TrussPart") then
		return "box", true
	end
	if part:IsA("WedgePart") then
		return "wedge", false
	end
	if part:IsA("CornerWedgePart") then
		return "cornerwedge", false
	end
	if part:IsA("Part") then
		local okShape, partType = pcall(function()
			return (part :: Part).Shape
		end)
		if okShape then
			local named = SHAPE_BY_PART_TYPE[partType]
			if named then
				return named, false
			end
			-- Wedge and CornerWedge exist on PartType in newer builds; compare by name so
			-- an older Studio without those enum members does not error on lookup.
			local asName = tostring(partType):gsub("^Enum%.PartType%.", "")
			if asName == "Wedge" then
				return "wedge", false
			end
			if asName == "CornerWedge" then
				return "cornerwedge", false
			end
		end
		return "box", false
	end
	return "box", true
end

local function round3(n: number): number
	if n ~= n or n == math.huge or n == -math.huge then
		return 0
	end
	return math.floor(n * 1000 + 0.5) / 1000
end

handlers.getGeometry = function(_context, payload)
	local instance = requireInstance(payload.ref)
	local maxParts = math.clamp(tonumber(payload.maxParts) or 400, 1, 2000)

	local parts = {}
	local approximated = 0
	local visited = 0
	local truncated = false

	local function add(part: BasePart)
		local shape, isApproximate = shapeOf(part)
		if isApproximate then
			approximated += 1
		end

		local size = part.Size
		local cf = part.CFrame
		local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = cf:GetComponents()
		local color = part.Color

		parts[#parts + 1] = {
			name = part.Name,
			className = part.ClassName,
			shape = shape,
			approximate = isApproximate,
			size = { round3(size.X), round3(size.Y), round3(size.Z) },
			-- position first, then the rotation matrix row by row, exactly as
			-- CFrame:GetComponents orders them.
			cframe = {
				round3(x),
				round3(y),
				round3(z),
				round3(r00),
				round3(r01),
				round3(r02),
				round3(r10),
				round3(r11),
				round3(r12),
				round3(r20),
				round3(r21),
				round3(r22),
			},
			color = { round3(color.R), round3(color.G), round3(color.B) },
			transparency = round3(part.Transparency),
			material = tostring(part.Material):gsub("^Enum%.Material%.", ""),
		}
	end

	-- Iterative walk with a visit budget: GetDescendants on a large model allocates the
	-- whole list up front, and a preview never needs more than the first few hundred.
	local stack: { Instance } = { instance }
	while #stack > 0 do
		local current = table.remove(stack) :: Instance
		visited += 1
		if visited > 25000 then
			truncated = true
			break
		end

		if current:IsA("BasePart") then
			local ok = pcall(add, current)
			if ok and #parts >= maxParts then
				truncated = true
				break
			end
		end

		local okChildren, children = pcall(function()
			return current:GetChildren()
		end)
		if okChildren then
			for _, child in ipairs(children) do
				stack[#stack + 1] = child
			end
		end
	end

	return {
		name = instance.Name,
		className = instance.ClassName,
		path = Serializer.fullPath(instance),
		parts = parts,
		approximated = approximated,
		truncated = truncated,
		maxParts = maxParts,
	}
end

handlers.stats = function(context, _payload)
	return {
		refs = Registry.size(),
		subscriptions = Watcher.subscriptionCount(context.watcher),
	}
end

--- Runs a command, converting any error into a failed result event.
function Commands.dispatch(context: Context, command: { [string]: any }): { [string]: any }
	local handler = handlers[command.type]
	if not handler then
		return { type = "result", id = command.id, ok = false, error = "unknown-command:" .. tostring(command.type) }
	end

	local ok, result = pcall(handler, context, command)
	if not ok then
		Log.debug("command failed:", command.type, result)
		return { type = "result", id = command.id, ok = false, error = tostring(result) }
	end
	return { type = "result", id = command.id, ok = true, data = result }
end

Commands.ROOT_SERVICES = ROOT_SERVICES

return Commands
