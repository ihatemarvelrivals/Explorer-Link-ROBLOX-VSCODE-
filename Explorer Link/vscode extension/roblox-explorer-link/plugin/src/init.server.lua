--[[
	Explorer Link — Roblox Studio side.

	Mirrors this place's Explorer into VS Code: the tree, class icons, properties, and
	read-only script source. VS Code hosts the HTTP server; this plugin is the client
	and drives every exchange, because Luau has no WebSocket client and cannot listen
	for inbound connections.

	Nothing here writes to the DataModel. The only side effects are Selection changes
	and opening a script tab, both of them things the user explicitly asked for from
	the VS Code side.

	Repo: https://github.com/<you>/roblox-explorer-link
]]

local RunService = game:GetService("RunService")

local Config = require(script.Config)
local Log = require(script.Log)
local Registry = require(script.Registry)
local Transport = require(script.Transport)
local Ui = require(script.Ui)
local Watcher = require(script.Watcher)

-- Studio runs plugin scripts in edit mode and again inside a play-test session. Only
-- the edit-mode copy should hold the link, otherwise pressing Play spawns a second
-- client that fights the first one for the same session id.
if not RunService:IsEdit() then
	return
end

local toolbar = plugin:CreateToolbar("Explorer Link")
local ui = Ui.new(plugin, toolbar)

local transport
local watcher = Watcher.new(function(event)
	if transport then
		Transport.emit(transport, event)
	end
end)

transport = Transport.new(plugin, watcher)
transport.onStatus = function(status, message)
	Ui.setStatus(ui, status, message)
end

ui.onReconnect = function()
	Transport.reconnect(transport)
end

Watcher.startSelectionMirror(watcher)
Transport.start(transport)

-- Saving under a different name, or opening another place, invalidates every ref VS
-- Code holds. Cheaper to make it re-handshake than to try to remap.
local placeConnection = game:GetPropertyChangedSignal("PlaceId"):Connect(function()
	Log.info("place changed; resetting link")
	Registry.clear()
	Watcher.destroy(watcher)
	Watcher.startSelectionMirror(watcher)
	Transport.reconnect(transport)
end)

plugin.Unloading:Connect(function()
	placeConnection:Disconnect()
	Transport.stop(transport, "plugin-unloading")
	Watcher.destroy(watcher)
	Ui.destroy(ui)
	Registry.clear()
end)

Log.info(string.format("v%s ready — waiting for VS Code on port %d", Config.VERSION, Config.get(plugin).port))
