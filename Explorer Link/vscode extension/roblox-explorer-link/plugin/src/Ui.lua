--!strict
--[[
	Ui — toolbar button and a small dock widget.

	The widget exists for exactly three things: see whether the link is up, paste the
	pairing token, and change the port. Everything else happens in VS Code.

	Colours come from Studio's own theme so the widget follows dark/light automatically.
]]

local Config = require(script.Parent.Config)

local Ui = {}
Ui.__index = Ui

export type Ui = typeof(setmetatable(
	{} :: {
		pluginRef: Plugin,
		widget: DockWidgetPluginGui,
		button: PluginToolbarButton,
		statusLabel: TextLabel,
		statusDot: Frame,
		detailLabel: TextLabel,
		tokenBox: TextBox,
		portBox: TextBox,
		onReconnect: (() -> ())?,
		connections: { RBXScriptConnection },
	},
	Ui
))

local COLORS = {
	offline = Color3.fromRGB(198, 82, 82),
	connecting = Color3.fromRGB(214, 165, 68),
	connected = Color3.fromRGB(88, 176, 106),
}

local function studioColor(item: Enum.StudioStyleGuideColor, modifier: Enum.StudioStyleGuideModifier?): Color3
	local theme = settings().Studio.Theme
	return theme:GetColor(item, modifier or Enum.StudioStyleGuideModifier.Default)
end

local function makeLabel(parent: Instance, text: string, size: UDim2, position: UDim2, bold: boolean): TextLabel
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Size = size
	label.Position = position
	label.Font = if bold then Enum.Font.GothamBold else Enum.Font.Gotham
	label.TextSize = if bold then 14 else 12
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextYAlignment = Enum.TextYAlignment.Center
	label.Text = text
	label.TextColor3 = studioColor(Enum.StudioStyleGuideColor.MainText)
	label.Parent = parent
	return label
end

local function makeBox(parent: Instance, placeholder: string, position: UDim2, width: number): TextBox
	local box = Instance.new("TextBox")
	box.Size = UDim2.new(0, width, 0, 26)
	box.Position = position
	box.Font = Enum.Font.Code
	box.TextSize = 13
	box.ClearTextOnFocus = false
	box.PlaceholderText = placeholder
	box.Text = ""
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.BackgroundColor3 = studioColor(Enum.StudioStyleGuideColor.InputFieldBackground)
	box.TextColor3 = studioColor(Enum.StudioStyleGuideColor.MainText)
	box.PlaceholderColor3 = studioColor(Enum.StudioStyleGuideColor.DimmedText)
	box.BorderSizePixel = 0

	local padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, 8)
	padding.Parent = box

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 4)
	corner.Parent = box

	box.Parent = parent
	return box
end

function Ui.new(pluginRef: Plugin, toolbar: PluginToolbar): Ui
	local button = toolbar:CreateButton(
		"Explorer Link",
		"Open the Explorer Link panel — mirrors this place's Explorer into VS Code",
		"rbxasset://textures/StudioSharedUI/menu.png"
	)
	button.ClickableWhenViewportHidden = true

	local widget = pluginRef:CreateDockWidgetPluginGui(
		"ExplorerLink_Panel",
		DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 320, 220, 300, 200)
	)
	widget.Title = "Explorer Link"
	widget.Name = "ExplorerLink"
	widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = studioColor(Enum.StudioStyleGuideColor.MainBackground)
	root.BorderSizePixel = 0
	root.Parent = widget

	local statusDot = Instance.new("Frame")
	statusDot.Size = UDim2.fromOffset(10, 10)
	statusDot.Position = UDim2.fromOffset(14, 17)
	statusDot.BackgroundColor3 = COLORS.offline
	statusDot.BorderSizePixel = 0
	local dotCorner = Instance.new("UICorner")
	dotCorner.CornerRadius = UDim.new(1, 0)
	dotCorner.Parent = statusDot
	statusDot.Parent = root

	local statusLabel = makeLabel(root, "Not connected", UDim2.new(1, -40, 0, 18), UDim2.fromOffset(32, 13), true)
	local detailLabel = makeLabel(root, "", UDim2.new(1, -40, 0, 16), UDim2.fromOffset(32, 32), false)
	detailLabel.TextColor3 = studioColor(Enum.StudioStyleGuideColor.DimmedText)

	makeLabel(root, "Pairing token", UDim2.new(1, -28, 0, 14), UDim2.fromOffset(14, 62), false).TextColor3 =
		studioColor(Enum.StudioStyleGuideColor.DimmedText)
	local tokenBox = makeBox(root, "paste from the VS Code status bar", UDim2.fromOffset(14, 78), 292)

	makeLabel(root, "Port", UDim2.new(0, 100, 0, 14), UDim2.fromOffset(14, 114), false).TextColor3 =
		studioColor(Enum.StudioStyleGuideColor.DimmedText)
	local portBox = makeBox(root, tostring(Config.DEFAULT_PORT), UDim2.fromOffset(14, 130), 100)

	local reconnect = Instance.new("TextButton")
	reconnect.Size = UDim2.fromOffset(178, 26)
	reconnect.Position = UDim2.fromOffset(128, 130)
	reconnect.Text = "Save & reconnect"
	reconnect.Font = Enum.Font.GothamMedium
	reconnect.TextSize = 13
	reconnect.BackgroundColor3 = studioColor(Enum.StudioStyleGuideColor.DialogMainButton)
	reconnect.TextColor3 = studioColor(Enum.StudioStyleGuideColor.DialogMainButtonText)
	reconnect.BorderSizePixel = 0
	local buttonCorner = Instance.new("UICorner")
	buttonCorner.CornerRadius = UDim.new(0, 4)
	buttonCorner.Parent = reconnect
	reconnect.Parent = root

	local hint = makeLabel(
		root,
		"VS Code: run “Explorer Link: Show Pairing Token”",
		UDim2.new(1, -28, 0, 14),
		UDim2.fromOffset(14, 168),
		false
	)
	hint.TextColor3 = studioColor(Enum.StudioStyleGuideColor.DimmedText)
	hint.TextSize = 11

	local settingsNow = Config.get(pluginRef)
	tokenBox.Text = settingsNow.token
	portBox.Text = tostring(settingsNow.port)

	local self = setmetatable({
		pluginRef = pluginRef,
		widget = widget,
		button = button,
		statusLabel = statusLabel,
		statusDot = statusDot,
		detailLabel = detailLabel,
		tokenBox = tokenBox,
		portBox = portBox,
		onReconnect = nil,
		connections = {},
	}, Ui)

	table.insert(
		self.connections,
		button.Click:Connect(function()
			widget.Enabled = not widget.Enabled
		end)
	)

	table.insert(
		self.connections,
		reconnect.Activated:Connect(function()
			local port = tonumber(portBox.Text) or Config.DEFAULT_PORT
			-- Ports below 1024 are blocked for plugin requests; refuse rather than
			-- letting the user watch a silent failure.
			if port < 1024 or port > 65535 then
				portBox.Text = tostring(Config.DEFAULT_PORT)
				port = Config.DEFAULT_PORT
			end
			Config.set(pluginRef, { token = tokenBox.Text, port = port })
			if self.onReconnect then
				self.onReconnect()
			end
		end)
	)

	table.insert(
		self.connections,
		settings().Studio.ThemeChanged:Connect(function()
			root.BackgroundColor3 = studioColor(Enum.StudioStyleGuideColor.MainBackground)
			statusLabel.TextColor3 = studioColor(Enum.StudioStyleGuideColor.MainText)
			detailLabel.TextColor3 = studioColor(Enum.StudioStyleGuideColor.DimmedText)
			hint.TextColor3 = studioColor(Enum.StudioStyleGuideColor.DimmedText)
			for _, box in ipairs({ tokenBox, portBox }) do
				box.BackgroundColor3 = studioColor(Enum.StudioStyleGuideColor.InputFieldBackground)
				box.TextColor3 = studioColor(Enum.StudioStyleGuideColor.MainText)
			end
			reconnect.BackgroundColor3 = studioColor(Enum.StudioStyleGuideColor.DialogMainButton)
			reconnect.TextColor3 = studioColor(Enum.StudioStyleGuideColor.DialogMainButtonText)
		end)
	)

	return (self :: any) :: Ui
end

function Ui.setStatus(self: Ui, status: string, message: string)
	self.statusDot.BackgroundColor3 = COLORS[status] or COLORS.offline
	self.statusLabel.Text = if status == "connected"
		then "Linked"
		elseif status == "connecting" then "Connecting…"
		else "Not connected"
	self.detailLabel.Text = message
	self.button:SetActive(status == "connected")
end

function Ui.destroy(self: Ui)
	for _, connection in ipairs(self.connections) do
		connection:Disconnect()
	end
	self.connections = {}
	self.widget:Destroy()
end

return Ui
