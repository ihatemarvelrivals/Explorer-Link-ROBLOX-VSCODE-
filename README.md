this is a free use project, you don't have to credit me.

TUTORIAL:

1. Install the Studio plugin

https://create.roblox.com/store/asset/88873038504274/Explorer-Link

if you cant install it through this link then do this:
Open Studio → Plugins tab → Plugins Folder button. That opens the right directory (%LOCALAPPDATA%\Roblox\Plugins on Windows, ~/Documents/Roblox/Plugins on Mac).

Drop ExplorerLink.rbxmx (Thats in Explorer Link\roblox plugin) in there, then fully restart Studio. You should see a new Explorer Link button in the Plugins tab, and [ExplorerLink] v1.0.0 ready in the Output window.

2. Build the extension

Find the roblox-explorer-link folder path and copy it
(For me its C:\Users\Owner\Downloads\Explorer Link\vscode extension\roblox-explorer-link)

Go into vscode and in the top right tabs select Terminal -> New Terminal

And enter in the commands once each in order from top to bottom

commands:
cd roblox-explorer-link/extension
npm install
npm run compile

When it's done you'll have a file called roblox-explorer-link-1.2.1.vsix in that folder.

Now on the left tab select Extensions (the four boxes)

At the top of the tab you should see the name "Extensions" to the right edge of that tab you'll see 3 dots (next to the refresh icon) click that
then select Install from VSIX

Now find your roblox-explorer-link file again and look in the folder named "extension" and select roblox-explorer-link-1.2.1.vsix

(restart extensions if needed)

Step 3: pair them

In VS Code, press <kbd>Ctrl+Shift+P</kbd> (<kbd>Cmd+Shift+P</kbd> on Mac). A search box drops down from the top. Type:

Explorer Link: Show Pairing Token

Press Enter. A notification appears in the bottom-right with a string of letters and numbers — click Copy token.

In Studio, go to the Plugins tab in the ribbon and click Explorer Link. A small floating panel opens. (If you don't see it, it may have opened behind the Studio window.)

Paste the token into the Pairing token box, then click Save & reconnect.

Studio will now ask permission, something like "Explorer Link wants to communicate with localhost". Click Allow. This is the one that actually matters; without it the plugin can't reach VS Code at all, and it only asks once.

Step 4: check it's live

The dot in the Studio panel turns green and says Linked.

Over in VS Code:

The bottom-right status bar changes from Roblox: waiting to your place's name
Click the cube icon in the left bar your Explorer tree is there

USAGE:

Expand a service to see inside it — it fetches children as you open them, so a big place stays fast
Click a script and its source opens in a tab. Read-only — edit it in Studio and the tab updates itself
Click any row and it selects that instance in Studio; select something in Studio and it highlights here
Right-click a row for Reveal in Studio and Copy Path
The magnifying glass at the top of the panel is Go to Path — type game.ReplicatedStorage.Modules.Combat and it jumps there instead of making you expand four levels

Add a Part in Studio and watch it appear in VS Code without refreshing.

NOTE: press Play and the tree empties. The plugin only holds the link in edit mode, deliberately otherwise a second copy of it runs inside the playtest and fights the first one. Stop the test and it comes back.

I would love to know what improvements/adjustments would make this even better, please share if you can as this project is still in alpha.
