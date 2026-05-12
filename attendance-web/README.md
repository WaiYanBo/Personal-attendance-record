# Daily Attendance Website

A small attendance site that:

- uses a hardcoded username and password
- remembers the login on the same browser
- records check-in and check-out in 24-hour time
- stores data in Google Sheets
- calculates hours worked on checkout

## Project structure

- `Attendance` sheet: one row per day
- `Activity Log` sheet: one row per action

## Setup

1. Create a Google Cloud project.
2. Enable the Google Sheets API.
3. Create a service account and download the JSON key, or copy the `client email` and `private key` values from that JSON.
4. Open your sheet and share it with the service account email so the app can write to it.
5. Copy `.env.example` to `.env` and set either `GOOGLE_SHEETS_ID` or `GOOGLE_SHEETS_URL`.
6. Install dependencies:

```bash
npm install
```

7. Start the app:

```bash
npm start
```

Then open the local URL shown in the terminal.

## Using your sheet link

Your link is valid as-is:

`https://docs.google.com/spreadsheets/d/1sb3J3hBYkUWq6Z3FatxSenOoVv3SGZbVh7p6qb9YEgc/edit?usp=sharing`

You can paste that full link into `GOOGLE_SHEETS_URL`, or copy just the ID part into `GOOGLE_SHEETS_ID`:

`1sb3J3hBYkUWq6Z3FatxSenOoVv3SGZbVh7p6qb9YEgc`

The link alone is not enough. The sheet must also be shared with the service account email, otherwise Google will reject the write request.

## Login

The username and password are hardcoded in `server.js`:

- username: `admin`
- password: `1234`

Change them there if you want different credentials.

## Google Sheets columns

The app will create these headers if the tabs are empty:

- `Attendance`: Date, Check In, Check Out, Hours Worked, Check In ISO, Check Out ISO, Updated At
- `Activity Log`: Recorded At, Date, Action, Time, Hours Worked, Note

## Notes

- The browser remembers your login with local storage.
- Times are displayed in 24-hour format.
- Set `TIME_ZONE` in `.env` if you want the displayed attendance time to follow a specific timezone.
