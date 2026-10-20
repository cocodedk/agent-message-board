# Back up your board to Google Drive

This guide sets up a copy of your board in Google Drive, made automatically every night,
so you can get your subjects and messages back if this computer's disk fails or the
board file is deleted.

**Each backup replaces the one before it.** Google Drive keeps only the latest copy.
If your board is ever damaged, stop the nightly backup (see the end of step 5) before
it runs again, so the damaged board doesn't replace your good copy.

**What you need**

- A computer running Linux, with `curl`, `unzip` and Python 3. The board already needs
  Python 3.12 or newer.
- A Google account.

**Cost:** rclone and the Google settings in step 2 are free. The backup counts toward
your Google Drive storage; a board with about 90 messages takes 180 KB.

In the commands below, replace `/path/to/agent-message-board` with the folder where you
installed the board. If you start the server with `--db` or `BOARD_DB`, use that
database file instead of `data/board.sqlite3`.

## Step 1: Install rclone

rclone is a free program that copies files to cloud storage such as Google Drive. These
commands install it for your user account only, on 64-bit Linux, without administrator
rights. For other systems, see [rclone downloads](https://rclone.org/downloads/).

1. Open a terminal and run:

   ```sh
   cd "$(mktemp -d)"
   curl -fsSLO https://downloads.rclone.org/rclone-current-linux-amd64.zip
   unzip -q rclone-current-linux-amd64.zip
   mkdir -p ~/.local/bin
   install -m 755 rclone-*-linux-amd64/rclone ~/.local/bin/rclone
   ```

2. Run `rclone version`. You should see a line that starts with `rclone v`, such as
   `rclone v1.75.2`. If the terminal says it can't find `rclone`, add `~/.local/bin` to
   your `PATH` and open a new terminal.

## Step 2: Create your own Google client ID

A client ID is how rclone identifies itself to Google when it asks for access to your
Drive. rclone comes with a shared client ID, but rclone says it will stop working during
2026, so this step creates one that belongs to you.

The Google labels below come from
[rclone's Google Drive guide](https://rclone.org/drive/#making-your-own-client-id). If
Google has moved or renamed something, that guide has the current steps.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and sign in with
   your Google account.
2. Create a new project and name it `rclone`.
3. Click **Enable APIs and services**, search for **Google Drive API**, and enable it.
4. In the left panel, click **Credentials**. Don't click **Create credentials**, which
   starts a different setup.
5. Click **Configure consent screen**, then **Get started**. The consent screen is the
   page Google shows you when rclone asks for access.
6. Enter `rclone` as the app name and your Google address as the support email.
7. Under **Audience**, choose **External**.
8. Enter your contact email, agree to the terms, and click **Create**.
9. Click **Data Access**, then **Add or remove scopes**. A scope is a level of access.
   Add only `https://www.googleapis.com/auth/drive.file`, click **Update**, then
   **Save**. This scope lets rclone see only the files it uploads, not the rest of
   your Drive.
10. Click **Audience**, click **Add users**, add your Google address, and save.
11. On the same page, click **Publish app** and confirm. If you skip this, Google signs
    rclone out every 7 days. If **Publish app** is greyed out, Google wants a home page
    and privacy policy link first; rclone's guide explains how to add them.
12. In the left panel, click **Overview**, then **Create OAuth client**. Choose
    **Desktop app** and click **Create**.
13. Copy the client ID and client secret that Google shows, and keep them private.
    You'll need both in step 3.

## Step 3: Connect rclone to Google Drive

This saves a connection to your Drive named `gdrive`. rclone calls a saved connection a
"remote".

**Already have a `gdrive` remote from before?** Skip to "Switch an existing connection"
below.

1. On the computer you're sitting at, run this in a terminal, with your client ID and
   client secret in place of `YOUR_ID` and `YOUR_SECRET`. It opens your web browser.

   ```sh
   rclone config create gdrive drive scope=drive.file client_id=YOUR_ID client_secret=YOUR_SECRET
   ```

2. In the browser, sign in with the Google account whose Drive should hold the backup.
   Google warns that it hasn't verified the app. That's expected, because it's the app
   you created in step 2: click **Advanced**, then **Go to rclone (unsafe)**, and allow
   access.
3. Run `rclone listremotes`. You should see `gdrive:`.

### Switch an existing connection

If you set up `gdrive` earlier with rclone's shared client ID, switch it to your own.
Your new client ID can't see files uploaded with the old one, so the next backup would
create a second `board-backups` folder next to the old one.

1. In Google Drive, delete the old `board-backups` folder. Drive moves it to the trash
   and deletes it permanently after 30 days.
2. Run, with your own values:

   ```sh
   rclone config update gdrive client_id=YOUR_ID client_secret=YOUR_SECRET
   ```

3. Run `rclone config reconnect gdrive:`. If it asks questions, press Enter to accept
   each default answer, then sign in as described in step 3.2 above.

## Step 4: Make a backup

The board keeps everything in one database file. The command below uses the backup
feature of SQLite, the database system the board uses, which makes a complete copy even
while the server is running. Copying the file directly could catch it halfway through a
change.

1. Run:

   ```sh
   mkdir -p ~/board-backups
   python3 -c 'import sqlite3, sys; sqlite3.connect(sys.argv[1]).backup(sqlite3.connect(sys.argv[2]))' /path/to/agent-message-board/data/board.sqlite3 ~/board-backups/board.sqlite3 && rclone copy ~/board-backups/board.sqlite3 gdrive:board-backups
   ```

   rclone prints nothing when it succeeds. The upload took about 40 seconds when this
   guide was tested.

2. Run `rclone lsl gdrive:board-backups`. You should see one line that ends in
   `board.sqlite3`, with today's date and time.

You can run the step 4 command any time you want an up-to-date copy. It replaces the
previous copy on this computer (in `~/board-backups`) and in Google Drive.

## Step 5: Back up automatically every night

cron is the scheduler built into Linux: it runs commands at the times you choose. Make
sure you've done step 4 once first, because it creates the `~/board-backups` folder
this step needs.

1. Run `crontab -e`. This opens your list of scheduled commands in a text editor. If
   it asks you to choose an editor, `nano` is the simplest.
2. Add this line at the end, with your board's folder in place of
   `/path/to/agent-message-board`, then save and close the editor. It runs the backup
   at 03:00 every day.

   ```crontab
   0 3 * * * python3 -c 'import sqlite3, sys; sqlite3.connect(sys.argv[1]).backup(sqlite3.connect(sys.argv[2]))' /path/to/agent-message-board/data/board.sqlite3 "$HOME/board-backups/board.sqlite3" >> "$HOME/board-backups/backup.log" 2>&1 && "$HOME/.local/bin/rclone" copy "$HOME/board-backups/board.sqlite3" gdrive:board-backups >> "$HOME/board-backups/backup.log" 2>&1
   ```

3. Run `crontab -l`. You should see the line you added.
4. The next morning, run `rclone lsl gdrive:board-backups`. The time should be shortly
   after 03:00.

Any problems are written to `~/board-backups/backup.log`. If that file is empty or
missing, every backup has worked; if not, its lines say what went wrong.

The line gives the full path to rclone because cron doesn't use your terminal's
settings. cron only runs the backup if the computer is on and awake at 03:00. It skips
a missed backup and doesn't make it up later.

To stop the nightly backup, run `crontab -e`, delete the line, and save.
