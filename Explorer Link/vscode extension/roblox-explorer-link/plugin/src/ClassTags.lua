--!strict
--[[
	ClassTags — a curated ancestry, most specific first.

	The extension picks an icon by exact ClassName, then walks these tags in order, then
	falls back to a generic instance icon. That means a class Roblox ships next month
	still lands on a sensible icon without shipping or fetching an API dump, and the
	extension never needs to know the full class hierarchy.

	Order matters: the list is walked top to bottom and the first IsA match wins, so
	narrow classes must come before the base classes they inherit from.
]]

local ClassTags = {}

local ORDERED: { string } = {
	-- Scripts first: they are what people are here for.
	"ModuleScript",
	"LocalScript",
	"Script",
	"BaseScript",
	"LuaSourceContainer",

	-- Parts and geometry.
	"MeshPart",
	"UnionOperation",
	"Terrain",
	"WedgePart",
	"CornerWedgePart",
	"TrussPart",
	"SpawnLocation",
	"Seat",
	"VehicleSeat",
	"Part",
	"BasePart",
	"Model",
	"Tool",
	"Accessory",
	"Folder",
	"Configuration",

	-- UI.
	"ScreenGui",
	"SurfaceGui",
	"BillboardGui",
	"TextButton",
	"ImageButton",
	"TextLabel",
	"TextBox",
	"ImageLabel",
	"ScrollingFrame",
	"CanvasGroup",
	"VideoFrame",
	"ViewportFrame",
	"Frame",
	"UIGridLayout",
	"UIListLayout",
	"UIPadding",
	"UICorner",
	"UIStroke",
	"UIGradient",
	"UIScale",
	"UIAspectRatioConstraint",
	"UIComponent",
	"GuiButton",
	"GuiLabel",
	"GuiObject",
	"LayerCollector",
	"GuiBase",

	-- Networking and data.
	"RemoteEvent",
	"UnreliableRemoteEvent",
	"RemoteFunction",
	"BindableEvent",
	"BindableFunction",

	-- Values.
	"StringValue",
	"IntValue",
	"NumberValue",
	"BoolValue",
	"ObjectValue",
	"CFrameValue",
	"Vector3Value",
	"Color3Value",
	"BrickColorValue",
	"RayValue",
	"ValueBase",

	-- Physics, joints, constraints.
	"Motor6D",
	"Weld",
	"WeldConstraint",
	"Attachment",
	"Constraint",
	"JointInstance",
	"BodyMover",
	"Humanoid",
	"HumanoidDescription",
	"Animator",
	"Animation",
	"AnimationController",

	-- Effects and audio.
	"ParticleEmitter",
	"Beam",
	"Trail",
	"Explosion",
	"Fire",
	"Smoke",
	"Sparkles",
	"Highlight",
	"SelectionBox",
	"Sound",
	"SoundGroup",
	"SoundEffect",
	"PointLight",
	"SpotLight",
	"SurfaceLight",
	"Light",
	"Decal",
	"Texture",
	"SurfaceAppearance",
	"Atmosphere",
	"Sky",
	"PostEffect",

	-- Misc containers and behaviour.
	"Camera",
	"Player",
	"Team",
	"ClickDetector",
	"ProximityPrompt",
	"TouchTransmitter",
	"Mesh",
	"CollectionService",
	"Script",
}

--- Builds the tag list for an instance. Always ends with the exact ClassName at the
--- front and "Instance" at the back, so the extension has a guaranteed first and last
--- resort.
function ClassTags.forInstance(instance: Instance): { string }
	local tags: { string } = { instance.ClassName }
	local seen: { [string]: boolean } = { [instance.ClassName] = true }

	for _, className in ipairs(ORDERED) do
		if not seen[className] then
			local ok, isA = pcall(function()
				return instance:IsA(className)
			end)
			if ok and isA then
				tags[#tags + 1] = className
				seen[className] = true
			end
		end
	end

	tags[#tags + 1] = "Instance"
	return tags
end

ClassTags.ORDERED = ORDERED

return ClassTags
