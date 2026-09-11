--!strict
--[[
	Serializer — turns instances and property values into the JSON shapes in PROTOCOL.md.

	Two jobs:
	  * node(instance) -> the tree row VS Code renders
	  * formatValue(v) -> a display string plus a `kind` used for colouring
]]

local ClassTags = require(script.Parent.ClassTags)
local Registry = require(script.Parent.Registry)

local Serializer = {}

local MAX_STRING = 240

--- game.Workspace.Sword.Handle — built by walking up rather than using GetFullName so
--- that names with dots or brackets do not silently produce an ambiguous path.
local function fullPath(instance: Instance): string
	if instance == game then
		return "game"
	end
	local segments: { string } = {}
	local current: Instance? = instance
	while current and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	if current ~= game then
		-- Detached from the DataModel; report what we have without the game prefix.
		return table.concat(segments, ".")
	end
	return "game." .. table.concat(segments, ".")
end

Serializer.fullPath = fullPath

--- The same walk, returned as segments. VS Code uses this to reveal a row by expanding
--- one ancestor at a time, which a dotted string cannot support unambiguously once a
--- name contains a dot.
function Serializer.pathSegments(instance: Instance): { string }
	local segments: { string } = {}
	local current: Instance? = instance
	while current and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	return segments
end

local function truncate(text: string): string
	if #text <= MAX_STRING then
		return text
	end
	return string.sub(text, 1, MAX_STRING) .. "…"
end

local function round(n: number): string
	if n ~= n then
		return "nan"
	end
	if n == math.huge then
		return "inf"
	end
	if n == -math.huge then
		return "-inf"
	end
	if math.abs(n - math.floor(n)) < 1e-9 then
		return string.format("%d", n)
	end
	-- The outer parentheses matter: gsub returns (string, count), and without them the
	-- count leaks into whatever argument list this call ends up in.
	return (string.format("%.3f", n):gsub("0+$", ""):gsub("%.$", ""))
end

--- Returns (displayString, kind). `kind` is a coarse type name the extension maps to a
--- colour; it is never parsed.
function Serializer.formatValue(value: any): (string, string)
	local valueType = typeof(value)

	if valueType == "string" then
		return truncate(value), "string"
	elseif valueType == "number" then
		return round(value), "number"
	elseif valueType == "boolean" then
		return tostring(value), "bool"
	elseif valueType == "nil" then
		return "nil", "nil"
	elseif valueType == "EnumItem" then
		return tostring(value):gsub("^Enum%.", ""), "enum"
	elseif valueType == "Vector3" then
		return string.format("%s, %s, %s", round(value.X), round(value.Y), round(value.Z)), "Vector3"
	elseif valueType == "Vector2" then
		return string.format("%s, %s", round(value.X), round(value.Y)), "Vector2"
	elseif valueType == "UDim" then
		return string.format("%s, %s", round(value.Scale), round(value.Offset)), "UDim"
	elseif valueType == "UDim2" then
		return string.format(
			"{%s, %s}, {%s, %s}",
			round(value.X.Scale),
			round(value.X.Offset),
			round(value.Y.Scale),
			round(value.Y.Offset)
		),
			"UDim2"
	elseif valueType == "CFrame" then
		local position = value.Position
		local rx, ry, rz = value:ToOrientation()
		return string.format(
			"%s, %s, %s  ∠ %s, %s, %s",
			round(position.X),
			round(position.Y),
			round(position.Z),
			round(math.deg(rx)),
			round(math.deg(ry)),
			round(math.deg(rz))
		),
			"CFrame"
	elseif valueType == "Color3" then
		return string.format("#%02X%02X%02X", value.R * 255, value.G * 255, value.B * 255), "Color3"
	elseif valueType == "BrickColor" then
		return value.Name, "BrickColor"
	elseif valueType == "NumberRange" then
		return string.format("%s .. %s", round(value.Min), round(value.Max)), "NumberRange"
	elseif valueType == "NumberSequence" or valueType == "ColorSequence" then
		return string.format("%d keypoints", #value.Keypoints), valueType
	elseif valueType == "Rect" then
		return string.format(
			"{%s, %s}, {%s, %s}",
			round(value.Min.X),
			round(value.Min.Y),
			round(value.Max.X),
			round(value.Max.Y)
		),
			"Rect"
	elseif valueType == "Instance" then
		return fullPath(value), "Instance"
	elseif valueType == "Font" then
		return tostring(value.Family):gsub("^rbxasset://fonts/families/", ""):gsub("%.json$", ""), "Font"
	elseif valueType == "PhysicalProperties" then
		return string.format("density %s, friction %s", round(value.Density), round(value.Friction)), "PhysicalProperties"
	end

	return truncate(tostring(value)), valueType
end

--- A tree row. `childCount` lets VS Code draw the expand twisty without a round trip.
function Serializer.node(instance: Instance): { [string]: any }
	local childCount = 0
	local okChildren, children = pcall(function()
		return instance:GetChildren()
	end)
	if okChildren then
		childCount = #children
	end

	local isScript = instance:IsA("LuaSourceContainer")
	local disabled = false
	if isScript and (instance:IsA("Script") or instance:IsA("LocalScript")) then
		local ok, value = pcall(function()
			return (instance :: any).Disabled
		end)
		disabled = ok and value == true
	end

	local isService = false
	if instance.Parent == game then
		isService = true
	end

	return {
		ref = Registry.refFor(instance),
		name = instance.Name,
		className = instance.ClassName,
		path = fullPath(instance),
		tags = ClassTags.forInstance(instance),
		childCount = childCount,
		flags = {
			script = isScript,
			disabled = disabled,
			service = isService,
		},
	}
end

--- Serializes an instance's children, skipping any that error on access.
function Serializer.children(instance: Instance): { { [string]: any } }
	local nodes = {}
	local ok, children = pcall(function()
		return instance:GetChildren()
	end)
	if not ok then
		return nodes
	end
	for _, child in ipairs(children) do
		local okNode, node = pcall(Serializer.node, child)
		if okNode then
			nodes[#nodes + 1] = node
		end
	end
	return nodes
end

return Serializer
