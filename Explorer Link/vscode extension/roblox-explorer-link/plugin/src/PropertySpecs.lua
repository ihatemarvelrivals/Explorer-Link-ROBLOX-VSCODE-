--!strict
--[[
	PropertySpecs — which properties to show, grouped like Studio's Properties window.

	Plugins have no reflection API, so there is no way to enumerate an arbitrary class's
	properties at runtime. Rather than ship (or download) a multi-megabyte API dump that
	goes stale, this is a curated table keyed by base class: every group whose class the
	instance IsA contributes its rows, most general first.

	Reads are pcall-guarded, and a property that errors or does not exist is simply
	omitted — so a group can safely list a property that only some subclasses have.
]]

local Serializer = require(script.Parent.Serializer)

local PropertySpecs = {}

type Group = { class: string, name: string, keys: { string } }

-- Ordered general -> specific, matching how Studio stacks inherited sections.
local GROUPS: { Group } = {
	{
		class = "Instance",
		name = "Instance",
		keys = { "Name", "ClassName", "Archivable" },
	},
	{
		class = "PVInstance",
		name = "Transform",
		keys = { "Origin", "Pivot" },
	},
	{
		class = "BasePart",
		name = "Part",
		keys = {
			"Size",
			"Position",
			"Rotation",
			"Anchored",
			"CanCollide",
			"CanQuery",
			"CanTouch",
			"Massless",
			"Material",
			"MaterialVariant",
			"Color",
			"BrickColor",
			"Transparency",
			"Reflectance",
			"CastShadow",
			"CollisionGroup",
			"RootPriority",
			"AssemblyLinearVelocity",
			"AssemblyAngularVelocity",
			"AssemblyMass",
			"CustomPhysicalProperties",
			"Shape",
		},
	},
	{
		class = "MeshPart",
		name = "Mesh",
		keys = { "MeshId", "TextureID", "RenderFidelity", "CollisionFidelity", "DoubleSided" },
	},
	{
		class = "Model",
		name = "Model",
		keys = { "PrimaryPart", "ModelStreamingMode", "LevelOfDetail", "WorldPivot" },
	},
	{
		class = "LuaSourceContainer",
		name = "Script",
		keys = { "Disabled", "RunContext", "LinkedSource", "Enabled" },
	},
	{
		class = "GuiObject",
		name = "Gui",
		keys = {
			"Position",
			"Size",
			"AnchorPoint",
			"AutomaticSize",
			"BackgroundColor3",
			"BackgroundTransparency",
			"BorderSizePixel",
			"BorderColor3",
			"ClipsDescendants",
			"LayoutOrder",
			"Rotation",
			"Visible",
			"ZIndex",
			"Active",
			"Selectable",
		},
	},
	{
		class = "TextLabel",
		name = "Text",
		keys = {
			"Text",
			"FontFace",
			"TextColor3",
			"TextSize",
			"TextScaled",
			"TextWrapped",
			"TextXAlignment",
			"TextYAlignment",
			"TextTransparency",
			"RichText",
		},
	},
	{
		class = "TextButton",
		name = "Text",
		keys = {
			"Text",
			"FontFace",
			"TextColor3",
			"TextSize",
			"TextScaled",
			"TextWrapped",
			"AutoButtonColor",
		},
	},
	{
		class = "TextBox",
		name = "Text",
		keys = { "Text", "PlaceholderText", "FontFace", "TextColor3", "TextSize", "ClearTextOnFocus", "MultiLine" },
	},
	{
		class = "ImageLabel",
		name = "Image",
		keys = { "Image", "ImageColor3", "ImageTransparency", "ScaleType", "SliceCenter", "TileSize" },
	},
	{
		class = "ImageButton",
		name = "Image",
		keys = { "Image", "HoverImage", "PressedImage", "ImageColor3", "ImageTransparency", "ScaleType" },
	},
	{
		class = "LayerCollector",
		name = "Gui",
		keys = { "Enabled", "ResetOnSpawn", "DisplayOrder", "IgnoreGuiInset", "ZIndexBehavior" },
	},
	{
		class = "ScrollingFrame",
		name = "Scrolling",
		keys = { "CanvasSize", "CanvasPosition", "AutomaticCanvasSize", "ScrollBarThickness", "ScrollingDirection" },
	},
	{
		class = "UIListLayout",
		name = "Layout",
		keys = { "FillDirection", "Padding", "SortOrder", "HorizontalAlignment", "VerticalAlignment", "Wraps" },
	},
	{
		class = "UIGridLayout",
		name = "Layout",
		keys = { "CellSize", "CellPadding", "FillDirection", "SortOrder", "StartCorner" },
	},
	{
		class = "UIPadding",
		name = "Padding",
		keys = { "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight" },
	},
	{
		class = "UICorner",
		name = "Corner",
		keys = { "CornerRadius" },
	},
	{
		class = "UIStroke",
		name = "Stroke",
		keys = { "Color", "Thickness", "Transparency", "ApplyStrokeMode", "LineJoinMode" },
	},
	{
		class = "ValueBase",
		name = "Value",
		keys = { "Value" },
	},
	{
		class = "Humanoid",
		name = "Humanoid",
		keys = {
			"Health",
			"MaxHealth",
			"WalkSpeed",
			"JumpPower",
			"JumpHeight",
			"UseJumpPower",
			"HipHeight",
			"AutoRotate",
			"PlatformStand",
			"RigType",
			"DisplayName",
		},
	},
	{
		class = "Attachment",
		name = "Attachment",
		keys = { "CFrame", "Position", "Orientation", "Visible", "WorldPosition" },
	},
	{
		class = "Constraint",
		name = "Constraint",
		keys = { "Attachment0", "Attachment1", "Enabled", "Visible", "Color" },
	},
	{
		class = "JointInstance",
		name = "Joint",
		keys = { "Part0", "Part1", "C0", "C1", "Enabled" },
	},
	{
		class = "Sound",
		name = "Sound",
		keys = { "SoundId", "Volume", "Playing", "Looped", "PlaybackSpeed", "TimePosition", "TimeLength", "RollOffMode" },
	},
	{
		class = "Light",
		name = "Light",
		keys = { "Brightness", "Color", "Enabled", "Shadows", "Range", "Angle", "Face" },
	},
	{
		class = "Decal",
		name = "Decal",
		keys = { "Texture", "Face", "Color3", "Transparency", "ZIndex" },
	},
	{
		class = "ParticleEmitter",
		name = "Emitter",
		keys = { "Texture", "Rate", "Lifetime", "Speed", "Enabled", "Color", "Size", "Transparency", "SpreadAngle" },
	},
	{
		class = "Beam",
		name = "Beam",
		keys = { "Attachment0", "Attachment1", "Texture", "Width0", "Width1", "Color", "Enabled", "FaceCamera" },
	},
	{
		class = "Camera",
		name = "Camera",
		keys = { "CFrame", "CameraType", "FieldOfView", "CameraSubject", "Focus" },
	},
	{
		class = "Tool",
		name = "Tool",
		keys = { "Grip", "CanBeDropped", "Enabled", "RequiresHandle", "ToolTip", "TextureId" },
	},
	{
		class = "ProximityPrompt",
		name = "Prompt",
		keys = { "ActionText", "ObjectText", "HoldDuration", "MaxActivationDistance", "Enabled", "RequiresLineOfSight" },
	},
	{
		class = "ClickDetector",
		name = "Click",
		keys = { "MaxActivationDistance", "CursorIcon" },
	},
	{
		class = "SpawnLocation",
		name = "Spawn",
		keys = { "Enabled", "Neutral", "TeamColor", "Duration", "AllowTeamChangeOnTouch" },
	},
	{
		class = "Terrain",
		name = "Terrain",
		keys = { "WaterColor", "WaterTransparency", "WaterWaveSize", "WaterWaveSpeed", "Decoration", "MaxExtents" },
	},
	{
		class = "Animation",
		name = "Animation",
		keys = { "AnimationId" },
	},
	{
		class = "SurfaceAppearance",
		name = "Surface",
		keys = { "ColorMap", "NormalMap", "MetalnessMap", "RoughnessMap", "AlphaMode" },
	},
}

--- Reads one property, returning nil if it does not exist or errors.
local function readRow(instance: Instance, key: string): { [string]: any }?
	local ok, value = pcall(function()
		return (instance :: any)[key]
	end)
	if not ok then
		return nil
	end
	-- ClassName is a string but deserves its own kind so the extension can style it.
	if key == "ClassName" then
		return { key = key, value = tostring(value), kind = "class" }
	end
	local display, kind = Serializer.formatValue(value)
	return { key = key, value = display, kind = kind }
end

--- Builds every applicable group for an instance, plus Attributes and Tags when present.
function PropertySpecs.groupsFor(instance: Instance): { { [string]: any } }
	local out = {}
	local seenKeys: { [string]: boolean } = {}

	for _, group in ipairs(GROUPS) do
		local okIsA, isA = pcall(function()
			return instance:IsA(group.class)
		end)
		if okIsA and isA then
			local rows = {}
			for _, key in ipairs(group.keys) do
				if not seenKeys[key] then
					local row = readRow(instance, key)
					if row then
						seenKeys[key] = true
						rows[#rows + 1] = row
					end
				end
			end
			if #rows > 0 then
				out[#out + 1] = { name = group.name, rows = rows }
			end
		end
	end

	local okAttributes, attributes = pcall(function()
		return instance:GetAttributes()
	end)
	if okAttributes and attributes then
		local rows = {}
		local names = {}
		for name in pairs(attributes) do
			names[#names + 1] = name
		end
		table.sort(names)
		for _, name in ipairs(names) do
			local display, kind = Serializer.formatValue(attributes[name])
			rows[#rows + 1] = { key = name, value = display, kind = kind }
		end
		if #rows > 0 then
			out[#out + 1] = { name = "Attributes", rows = rows }
		end
	end

	local okTags, tags = pcall(function()
		return game:GetService("CollectionService"):GetTags(instance)
	end)
	if okTags and tags and #tags > 0 then
		table.sort(tags)
		local rows = {}
		for index, tag in ipairs(tags) do
			rows[#rows + 1] = { key = tostring(index), value = tag, kind = "string" }
		end
		out[#out + 1] = { name = "Tags", rows = rows }
	end

	return out
end

return PropertySpecs
