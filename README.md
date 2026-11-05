# MapleScouter (semi) Autofill (for Chrome)

thanks claude (100% vibecoded)

Paste MapleStory screenshots and have the numbers typed into
<https://maplescouter.com/en/manual/input> for you.

## Install

1. Unzip this folder somewhere permanent (Chrome loads it from there).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped `MapleScouterAutofill` folder.
4. Pin the extension; clicking its icon opens the side panel.

## Use

1. Open MapleScouter's manual input page and select your class there (its stat table changes
   rows per class).
2. **Step 1 (Your class)** follows the class selected on MapleScouter automatically (also when you
   change it there). If it can't tell, pick it in the panel.
3. Paste screenshots with **Ctrl+V** (Win+Shift+S → drag a box → Ctrl+V in the panel). You can
   also drop files or browse. Order doesn't matter; each one is recognized automatically:
   - **Step 1** — STAT window with your **main stat's** STAT INFO pop-out open (click INT for Kanna).
   - **Step 2** — STAT window with each **secondary stat's** pop-out (LUK for Kanna; Shadower,
     Dual Blade and Cadena need both STR and DEX).
   - **Step 3** — STAT window with the **ATTACK POWER / MAGIC ATT** pop-out (MAGIC ATT for magicians),
     for the attack row of MapleScouter's stat table.
   - **Step 4** — the **HEXA Matrix** window (a full-screen shot that also shows the STAT window
     is read as both).
4. Check the values. Amber boxes were hard to read; everything is editable. The pop-out rows
   show ✓ when *Base × (1 + %) + Not applied = Current value* holds, so a ✓ means the numbers are right.
5. HEXA: press **Read MapleScouter's HEXA slots**. Each in-game core is matched to a site slot by
   its position in the HEXA Matrix (the layout is fixed, and MapleScouter's 15 slots follow it);
   icons are only used as a fallback. Hover a core to see how it was matched. If a pick is wrong,
   fix it with its drop-down — manual fixes are remembered per class. The last 2 site slots are
   ignored by default (change "Ignore last").
6. Press **Fill MapleScouter**. Filled boxes flash green on the page.

## If something doesn't fill

- The panel lists anything it couldn't find on the page. MapleScouter is found by its visible
  labels (e.g. "Final Damage", "HEXA Enhancement"), so a label rename on the site would show up there.
- HEXA icons are loaded from the page, by direct download, or by cropping a capture of the visible
  MapleScouter tab, whichever works. If some still can't be loaded, the panel says which slots;
  pick those with the drop-downs.
- **Copy diagnostics** (bottom of the panel) copies what the extension sees on the page — paste it
  into a bug report.
- A class missing or changed? Edit `lib/classes.js` and reload the extension.
