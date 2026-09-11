--!strict
--[[
	Config — user-tweakable settings, persisted through plugin:SetSetting.

	Everything the plugin needs to reach VS Code lives here. The defaults match the
	extension's defaults, so a fresh install of both sides connects with no setup.
]]

local Config = {}

Config.PROTOCOL = 1
Config.VERSION = "1.0.0"

-- Studio's trust check rejects the literal 127.0.0.1 for plugin requests, so the
-- hostname has to be "localhost". Ports below 1024 are blocked outright.
Config.DEFAULT_HOST = "localhost"
Config.DEFAULT_PORT = 34873

-- Event coalescing. A burst of DataModel churn becomes one request, not one per change.
Config.FLUSH_DEBOUNCE = 0.25
Config.FLUSH_DEBOUNCE_THROTTLED = 1.0

-- HttpService allows roughly 500 plugin requests per minute. Stay well under.
Config.REQUEST_BUDGET_PER_MINUTE = 300

-- Ceiling on the outbound queue, so a long VS Code outage cannot grow it without bound.
Config.MAX_QUEUED_EVENTS = 4000

-- Reconnect backoff ladder, in seconds.
Config.BACKOFF = { 1, 2, 5, 10 }

-- Above this many children we stop attaching per-child listeners to a subscribed node
-- and settle for parent-level add/remove events. Protects places with giant folders.
Config.PER_CHILD_LISTENER_LIMIT = 2000

local SETTING_KEY = "ExplorerLink_Config_v1"

type Stored = { host: string?, port: number?, token: string?, autoConnect: boolean? }

local cached: Stored? = nil

local function load(pluginRef: Plugin): Stored
	if cached then
		return cached
	end
	local ok, value = pcall(function()
		return pluginRef:GetSetting(SETTING_KEY)
	end)
	local stored: Stored = {}
	if ok and type(value) == "table" then
		stored = value :: any
	end
	cached = stored
	return stored
end

function Config.get(pluginRef: Plugin): { host: string, port: number, token: string, autoConnect: boolean }
	local stored = load(pluginRef)
	return {
		host = stored.host or Config.DEFAULT_HOST,
		port = stored.port or Config.DEFAULT_PORT,
		-- Empty means "no pairing token yet"; the extension shows one in its status bar.
		token = stored.token or "",
		autoConnect = if stored.autoConnect == nil then true else stored.autoConnect,
	}
end

function Config.set(pluginRef: Plugin, patch: Stored)
	local stored = load(pluginRef)
	for key, value in pairs(patch :: any) do
		(stored :: any)[key] = value
	end
	cached = stored
	pcall(function()
		pluginRef:SetSetting(SETTING_KEY, stored)
	end)
end

function Config.baseUrl(pluginRef: Plugin): string
	local settings = Config.get(pluginRef)
	return string.format("http://%s:%d", settings.host, settings.port)
end

return Config
