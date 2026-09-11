--!strict
--[[
	Registry — opaque refs for instances.

	VS Code never receives an Instance, only a string like "i:42". Refs are minted on
	demand (the first time an instance is serialized) and stay stable for the life of
	the session.

	Cleanup is lazy rather than eager. Connecting Destroying on every instance we have
	ever sent would cost more than it saves, so instead a ref resolves to nil once its
	instance leaves the DataModel, and dead entries are swept periodically.
]]

local Registry = {}

local nextId = 0
local byRef: { [string]: Instance } = {}
local byInstance: { [Instance]: string } = {}

--- Returns the existing ref for `instance`, minting one if this is the first time we
--- have seen it.
function Registry.refFor(instance: Instance): string
	local existing = byInstance[instance]
	if existing then
		return existing
	end
	nextId += 1
	local ref = "i:" .. nextId
	byRef[ref] = instance
	byInstance[instance] = ref
	return ref
end

--- Resolves a ref to a live instance, or nil if it is stale.
---
--- `game` itself is not a descendant of `game`, so it gets an explicit pass.
function Registry.resolve(ref: string): Instance?
	local instance = byRef[ref]
	if not instance then
		return nil
	end
	if instance == game then
		return instance
	end
	local ok, alive = pcall(function()
		return instance:IsDescendantOf(game)
	end)
	if not ok or not alive then
		byRef[ref] = nil
		byInstance[instance] = nil
		return nil
	end
	return instance
end

--- Looks up a ref without minting one. Used when reporting removals: an instance we
--- never sent to VS Code does not need to be announced.
function Registry.existingRef(instance: Instance): string?
	return byInstance[instance]
end

function Registry.forget(instance: Instance)
	local ref = byInstance[instance]
	if ref then
		byRef[ref] = nil
		byInstance[instance] = nil
	end
end

--- Drops entries whose instances have left the DataModel. Cheap enough to run on a
--- timer; the whole map is only as large as what the user has actually expanded.
function Registry.sweep(): number
	local removed = 0
	for ref, instance in pairs(byRef) do
		local ok, alive = pcall(function()
			return instance == game or instance:IsDescendantOf(game)
		end)
		if not ok or not alive then
			byRef[ref] = nil
			byInstance[instance] = nil
			removed += 1
		end
	end
	return removed
end

function Registry.clear()
	byRef = {}
	byInstance = {}
	nextId = 0
end

function Registry.size(): number
	local count = 0
	for _ in pairs(byRef) do
		count += 1
	end
	return count
end

return Registry
