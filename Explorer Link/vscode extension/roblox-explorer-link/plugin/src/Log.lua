--!strict
--[[
	Log — prefixed output with a verbosity switch.

	Connection churn is normal and expected (VS Code closes, Studio keeps running), so
	routine transport failures log at debug level and stay out of the user's Output
	window unless they turn verbose on.
]]

local Log = {}

local PREFIX = "[ExplorerLink]"

Log.verbose = false

function Log.info(...: any)
	print(PREFIX, ...)
end

function Log.warnf(...: any)
	warn(PREFIX, ...)
end

function Log.debug(...: any)
	if Log.verbose then
		print(PREFIX, "(debug)", ...)
	end
end

return Log
