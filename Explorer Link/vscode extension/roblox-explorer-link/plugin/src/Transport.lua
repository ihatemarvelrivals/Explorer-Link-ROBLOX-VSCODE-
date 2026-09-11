--!strict
--[[
	Transport — the HTTP client half of the link.

	Two cooperating loops, because one cannot do both jobs well:

	  * the poll loop holds a long request open (up to holdMs) waiting for commands from
	    VS Code, so an expand in the sidebar reaches Studio in milliseconds;
	  * the flush loop pushes queued events up, immediately when they are command
	    results and on a debounce when they are DataModel churn.

	Together they cost ~3 requests/minute at rest, well inside HttpService's ~500/minute
	plugin budget, and the budget is tracked anyway: if the place is thrashing, the
	debounce stretches rather than the link dying with a 429.
]]

local HttpService = game:GetService("HttpService")

local Commands = require(script.Parent.Commands)
local Config = require(script.Parent.Config)
local Log = require(script.Parent.Log)
local Registry = require(script.Parent.Registry)
local Watcher = require(script.Parent.Watcher)

local Transport = {}
Transport.__index = Transport

export type Status = "offline" | "connecting" | "connected"

export type Transport = typeof(setmetatable(
	{} :: {
		pluginRef: Plugin,
		watcher: Watcher.Watcher,
		running: boolean,
		sessionId: string?,
		token: string?,
		holdMs: number,
		queue: { { [string]: any } },
		urgent: boolean,
		backoffIndex: number,
		requestTimes: { number },
		status: Status,
		statusMessage: string,
		onStatus: ((Status, string) -> ())?,
	},
	Transport
))

function Transport.new(pluginRef: Plugin, watcher: Watcher.Watcher): Transport
	local self = setmetatable({
		pluginRef = pluginRef,
		watcher = watcher,
		running = false,
		sessionId = nil,
		token = nil,
		holdMs = 20000,
		queue = {},
		urgent = false,
		backoffIndex = 1,
		requestTimes = {},
		status = "offline" :: Status,
		statusMessage = "Not connected",
		onStatus = nil,
	}, Transport)
	return (self :: any) :: Transport
end

local function setStatus(self: Transport, status: Status, message: string)
	if self.status == status and self.statusMessage == message then
		return
	end
	self.status = status
	self.statusMessage = message
	if self.onStatus then
		self.onStatus(status, message)
	end
end

--- Queues an event for the next flush. `result` events mark the flush urgent so command
--- round trips are not held up by the change debounce.
function Transport.emit(self: Transport, event: { [string]: any })
	-- While VS Code is gone the watchers keep firing, so the queue needs a ceiling.
	-- Dropping the oldest is safe: reconnecting re-handshakes and resends the roots,
	-- and VS Code re-fetches whatever it has open from scratch.
	if #self.queue >= Config.MAX_QUEUED_EVENTS then
		table.remove(self.queue, 1)
	end
	self.queue[#self.queue + 1] = event
	if event.type == "result" then
		self.urgent = true
	end
end

local function recordRequest(self: Transport)
	local now = os.clock()
	table.insert(self.requestTimes, now)
	-- Drop anything older than a minute.
	local cutoff = now - 60
	while #self.requestTimes > 0 and self.requestTimes[1] < cutoff do
		table.remove(self.requestTimes, 1)
	end
end

local function isThrottled(self: Transport): boolean
	return #self.requestTimes >= Config.REQUEST_BUDGET_PER_MINUTE
end

type HttpResult = { ok: boolean, status: number, body: any, err: string? }

local function request(self: Transport, path: string, payload: { [string]: any }): HttpResult
	recordRequest(self)

	local headers: { [string]: string } = { ["Content-Type"] = "application/json" }
	if self.token then
		headers["X-Rel-Token"] = self.token
	end
	if self.sessionId then
		headers["X-Rel-Session"] = self.sessionId
	end

	local encoded
	local okEncode, encodeErr = pcall(function()
		encoded = HttpService:JSONEncode(payload)
	end)
	if not okEncode then
		return { ok = false, status = 0, body = nil, err = "encode:" .. tostring(encodeErr) }
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = Config.baseUrl(self.pluginRef) .. path,
			Method = "POST",
			Headers = headers,
			Body = encoded,
		})
	end)

	if not ok then
		-- Connection refused, DNS failure, trust check, timeout: all land here.
		return { ok = false, status = 0, body = nil, err = tostring(response) }
	end

	local decoded: any = nil
	if response.Body and #response.Body > 0 then
		local okDecode, value = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if okDecode then
			decoded = value
		end
	end

	return {
		ok = response.StatusCode >= 200 and response.StatusCode < 300,
		status = response.StatusCode,
		body = decoded,
		err = if response.StatusCode >= 300 then response.StatusMessage else nil,
	}
end

local function backoffSeconds(self: Transport): number
	local ladder = Config.BACKOFF
	local seconds = ladder[math.min(self.backoffIndex, #ladder)]
	self.backoffIndex += 1
	return seconds
end

function Transport.handshake(self: Transport): boolean
	setStatus(self, "connecting", "Looking for VS Code…")

	local settings = Config.get(self.pluginRef)
	self.token = if settings.token ~= "" then settings.token else nil

	local studioVersion = ""
	pcall(function()
		studioVersion = version()
	end)

	local result = request(self, "/hello", {
		protocol = Config.PROTOCOL,
		pluginVersion = Config.VERSION,
		placeName = game.Name,
		placeId = game.PlaceId,
		studioVersion = studioVersion,
		isEditMode = game:GetService("RunService"):IsEdit(),
	})

	if not result.ok then
		if result.status == 401 then
			setStatus(self, "offline", "Token rejected — copy it from the VS Code status bar")
			-- A wrong token will not fix itself; back off hard rather than hammering.
			self.backoffIndex = #Config.BACKOFF
		else
			setStatus(self, "offline", "VS Code not listening")
		end
		Log.debug("handshake failed:", result.status, result.err)
		return false
	end

	local body = result.body
	if type(body) ~= "table" or not body.sessionId then
		setStatus(self, "offline", "Unexpected reply from VS Code")
		return false
	end

	if body.protocol and body.protocol ~= Config.PROTOCOL then
		setStatus(
			self,
			"offline",
			string.format("Version mismatch: extension speaks v%s, plugin speaks v%d", tostring(body.protocol), Config.PROTOCOL)
		)
		self.backoffIndex = #Config.BACKOFF
		return false
	end

	self.sessionId = body.sessionId
	self.holdMs = body.holdMs or 20000
	self.backoffIndex = 1
	self.queue = {}

	setStatus(self, "connected", "Linked to VS Code")
	Log.info("connected to VS Code (session " .. tostring(body.sessionId):sub(1, 8) .. ")")

	-- The root rows are the one thing VS Code cannot ask for lazily: it has no ref yet.
	Transport.emit(self, { type = "roots", nodes = Commands.roots() })
	Transport.emit(self, { type = "placeChanged", placeName = game.Name, placeId = game.PlaceId })
	self.urgent = true

	return true
end

local function drain(self: Transport): { { [string]: any } }
	local events = self.queue
	self.queue = {}
	self.urgent = false
	return events
end

--- One /poll round trip. `hold` asks the server to keep the connection open when it has
--- nothing to say.
function Transport.poll(self: Transport, hold: boolean)
	local events = if hold then {} else drain(self)

	local result = request(self, "/poll", { events = events, want = hold })

	if not result.ok then
		-- Put the events back rather than dropping them: a lost childAdded leaves
		-- VS Code showing a tree that is quietly wrong until the next manual refresh.
		-- A dead session is the exception — those events describe a tree nobody has.
		if #events > 0 and result.status ~= 409 then
			for index = #events, 1, -1 do
				table.insert(self.queue, 1, events[index])
			end
		end

		if result.status == 409 then
			Log.debug("session expired; re-handshaking")
			self.sessionId = nil
			setStatus(self, "connecting", "VS Code restarted — reconnecting")
			return
		end
		if result.status == 429 then
			task.wait(2)
			return
		end
		if result.status == 503 or result.status == 0 then
			self.sessionId = nil
			setStatus(self, "offline", "VS Code not listening")
			return
		end
		Log.debug("poll failed:", result.status, result.err)
		return
	end

	local body = result.body
	if type(body) ~= "table" then
		return
	end

	local commands = body.commands
	if type(commands) ~= "table" then
		return
	end

	local context: Commands.Context = { watcher = self.watcher, pluginRef = self.pluginRef }
	for _, command in ipairs(commands) do
		Transport.emit(self, Commands.dispatch(context, command))
	end
end

function Transport.start(self: Transport)
	if self.running then
		return
	end
	self.running = true

	-- Poll loop: reconnects, then holds a long request open waiting for commands.
	task.spawn(function()
		while self.running do
			if not self.sessionId then
				local ok = Transport.handshake(self)
				if not ok then
					task.wait(backoffSeconds(self))
					continue
				end
			end
			local ok, err = pcall(Transport.poll, self, true)
			if not ok then
				Log.debug("poll loop error:", err)
				task.wait(1)
			end
		end
	end)

	-- Flush loop: pushes queued events up.
	task.spawn(function()
		local lastFlush = 0
		while self.running do
			task.wait(0.05)
			if not self.sessionId or #self.queue == 0 then
				continue
			end
			local debounce = if isThrottled(self) then Config.FLUSH_DEBOUNCE_THROTTLED else Config.FLUSH_DEBOUNCE
			local due = self.urgent or (os.clock() - lastFlush) >= debounce
			if due then
				lastFlush = os.clock()
				local ok, err = pcall(Transport.poll, self, false)
				if not ok then
					Log.debug("flush loop error:", err)
				end
			end
		end
	end)

	-- Housekeeping: drop refs whose instances have been destroyed.
	task.spawn(function()
		while self.running do
			task.wait(30)
			Registry.sweep()
		end
	end)
end

function Transport.stop(self: Transport, reason: string)
	if not self.running then
		return
	end
	self.running = false
	if self.sessionId then
		-- Best effort; if VS Code has already gone the failure is meaningless.
		pcall(function()
			request(self, "/poll", { events = { { type = "bye", reason = reason } }, want = false })
		end)
	end
	self.sessionId = nil
	setStatus(self, "offline", "Disconnected")
end

--- Forces an immediate reconnect, used by the toolbar button.
function Transport.reconnect(self: Transport)
	self.sessionId = nil
	self.backoffIndex = 1
	setStatus(self, "connecting", "Reconnecting…")
end

return Transport
