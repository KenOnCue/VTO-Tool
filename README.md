# OnCue VTO vehicle check

This is the phone page vehicle technical officers use at Jubilee Depot. It is one web page (`index.html`) plus a list of registrations (`vehicles.json`). Finished checks are sent to a Google Sheet through a Google Apps Script web app.

The script that receives the checks lives in `apps-script/Code.gs`. It is not installed automatically. Someone has to paste it into the fleet Google Sheet once, following the steps below.

## Adding or removing an ambulance

Two lists exist. The phone uses the first one it can load.

1. **Google Sheet (use this once the script below is installed).** On the spreadsheet, open the tab named `Registrations`. Add a row for each vehicle: column A is the registration as painted on the vehicle (`GN21 EBL`), column B is the type: `2crew`, `wav`, or `estate`. Leave column B blank only if that vehicle should appear under every type button. Delete a row to remove a vehicle. The next time a phone opens the check page, it picks up the change. Registrations that are not on this tab are refused, so a stranger cannot file a check against a made-up fleet number. Until this tab has at least one registration, the script does not refuse unknown registrations (so the first install does not block the fleet).

2. **`vehicles.json` (use this before the script is installed, and whenever a phone cannot reach Google).** Open `vehicles.json` and add or remove the registration in the `2crew`, `wav`, or `estate` list. Keep the quotes and commas. On GitHub: open the file, click the pencil, edit, and commit the change to `main`. GitHub Pages updates a minute or so later. Ask VTOs to refresh the page.

If neither list can be loaded, the page falls back to the registrations that were saved inside `index.html` when this version was built. You do not need to edit `index.html` to change the fleet.

## What the phone does with a check

The page shows success only when Google confirms the check was received.

- If there is no signal, the check stays on the phone (in the browser’s saved storage). A banner stays on screen. The phone sends it automatically when it is back online.
- If Google refuses the check, the page says so and keeps the copy. Nothing is thrown away.
- Photos are shrunk on the phone before they are sent. The signature drawing is sent as an image. Both are saved in the Google Drive folder you choose, and the sheet row stores the links.
- Until the new script is installed, the page still posts the same written fields as before (name, registration, checklist, and so on) so the existing sheet can keep receiving checks. It does not post the pictures to that old script, because the old script cannot store them and a large post can make it fail. Pictures stay on the phone and are filed after the new script is live. A check that already reached the old sheet can appear a second time once the pictures are filed. That second row is the one with the photos and the signature.

## Install the Google script

Do this once, on a computer, signed in as the Google account that owns the fleet sheet. Leave the phone page as it is until the last step.

1. Open the Google Sheet that should keep the vehicle checks.
2. Click **Extensions**, then **Apps Script**. A script editor opens. If you already have a script there, select all of the code and delete it.
3. Open `apps-script/Code.gs` from this project, select all of it, copy it, and paste it into the editor. Click the save icon.
4. In the Google Drive website, create a folder for check photos (for example `VTO check photos`). Open the folder. The address bar looks like `https://drive.google.com/drive/folders/THIS_PART_IS_THE_ID`. Copy the id (the long text after `/folders/`).
5. Share that folder with anyone who needs to open the photos. The links written into the sheet work for people who can open the folder. The photos are not made public to the internet.
6. Choose a long random token. A simple way: type a sentence no one else would guess, or use a password manager to generate about 30 characters. You will paste the same token in two places. Do not use the sample text `REPLACE_WITH_SHARED_TOKEN`.
7. In the Apps Script editor, click the gear icon (**Project settings**). Under **Script properties**, click **Add script property**.
   - Property `SUBMIT_TOKEN`, value: the token from step 6.
   - Click **Add script property** again. Property `DRIVE_FOLDER_ID`, value: the folder id from step 4.
   - Save the properties.
8. Optional. If checks should go to a tab that is not the first tab, add another property: `SHEET_NAME` = the tab name. If you skip this, rows are added to the first tab. If that tab is named `Registrations`, rows go to a tab called `Vehicle Checks` instead.
9. At the top of the editor, next to the function name, choose `testSetup` and click **Run**. Google will ask for permission. Choose the fleet account and allow access to Sheets and Drive. When it finishes, open **Execution log**. It should say the token is set and name the Drive folder. If it says NOT READY, fix the thing it names and run it again.
10. Click **Deploy**, then **Manage deployments**. If a web app deployment is already there (the one the phone uses today), click the pencil, set **Version** to **New version**, and click **Deploy**. The web address stays the same. If there is no deployment yet, click **Deploy**, then **New deployment**, choose the gear, choose **Web app**, and set:
    - Execute as: **Me**
    - Who has access: **Anyone**
    
    Copy the web app URL. It ends in `/exec`. Do not use the `/dev` address.
11. On the phone page, open `index.html` and find `SUBMIT_TOKEN` near the top of the script. Replace `REPLACE_WITH_SHARED_TOKEN` with the same token as step 6. If the web app URL changed in step 10, replace `SCRIPT_URL` with the new `/exec` URL as well. Commit that change so GitHub Pages publishes it.
12. On a phone, refresh the check page (close the tab and open it again if it was already open). File a test check with one photo and a signature. The sheet should gain a row, and the Drive folder should contain the signature and the photo. The phone should say the vehicle is ready or not ready only after that row exists. Turn the phone onto airplane mode and submit another check: it should say the check was not sent, and the banner should stay until you turn the signal back on.

After you change `Code.gs` later, repeat the pencil → **New version** → **Deploy** step. A saved script that is not deployed does not change what the phones talk to.

### If the row does not land on the tab you expect

The script writes to the first tab, matching today’s sheet, when row 1 looks like headings it knows (`VRN`, `VTO Name`, `Date`, and the other names listed in `Code.gs`). On a brand-new empty tab it adds those headings itself.

If the first tab already has rows and the headings are not ones it knows, it refuses to guess, and the phone keeps the check until you either add that heading row or set `SHEET_NAME` to a new tab. That avoids writing a registration into the wrong column.

## Limits of the shared token

The token is not a password you can keep secret. The check page is a public website, so anyone who can open the page can read the token in the page source and could send a check. It still helps: someone who only finds the script address (in a log, a screenshot, or the old bookmark) cannot post a check unless they also copy the token from the page. The registrations tab blocks registrations that are not on the fleet list, and the script rejects checks with a missing name, a bad registration, no signature, or photos that are not images.

It does not stop a person who has opened the real page. Stopping that would need a sign-in, which this page does not have. Do not put the token in `Code.gs` or in this README. The script property stays in your Google account. If the token leaks, change the script property and the same line in `index.html`, then deploy a new version.

The Drive folder should be shared only with staff. Links in the sheet open the files; they are not a separate public gallery unless you share the folder more widely.
