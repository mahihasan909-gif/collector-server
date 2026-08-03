# Collector Server

This is the backend server for the AI Code Detection project. It receives coding-activity sessions from the [Student Tracker VS Code extension](https://github.com/mahihasan909-gif/student-tracker), stores them in MongoDB, and provides:

- An **Admin Panel** (for teachers) to view student sessions, manage rooms (allowed student ID lists), generate/edit AI feedback, and download CSV data.
- A **Student Panel** where students log in with their student ID to see their sessions and feedback, plus an AI hint chatbot.

Live deployment: `https://collector-server-dz17.onrender.com`

## 1. What You Need

- Node.js (v18 or newer)
- A MongoDB Atlas connection string (or any MongoDB URI)
- (Optional) An OpenRouter API key, if you want AI-generated feedback and the AI hint chatbot to work

## 2. Environment Variables

Create these environment variables (on Render, set them in the service's "Environment" tab; locally, use a `.env` file or your shell):

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to run on (default `4000`) |
| `API_KEY` | Yes | Key the VS Code extension must send to upload a session |
| `INVITE_CODE` | Yes | Code teachers must enter to register a new admin account |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `OPENROUTER_API_KEY` | No | Needed for AI feedback generation and the AI hint chatbot |
| `OPENROUTER_MODEL` | No | Defaults to `openai/gpt-oss-20b:free` |

## 3. Run Locally

```bash
npm install
npm start
```

The server starts on `http://localhost:4000` (or your `PORT`).

## 4. Deploy on Render

1. Push this repo to GitHub.
2. Create a new **Web Service** on [Render](https://render.com), connect it to this repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add the environment variables listed above under the service's Environment tab.
6. Deploy. Render will auto-redeploy every time you push to `main`.

## 5. Admin Panel (Teachers)

Go to `/admin` on the server URL.

- **Register**: enter the invite code first, then a Gmail address and a password (6+ characters) to create your own private admin account.
- **Login**: use your Gmail address and password.
- Each admin only sees their own students, rooms, and data — completely isolated from other admins.

### Rooms

- **Manage Rooms**: create a room (a course/section, e.g. `cse103`) and paste the list of allowed student IDs. Only students in a room can log in through the VS Code extension or the Student Panel. A newly created room stays here for 24 hours.
- **Old Rooms**: after 24 hours, a room automatically moves here. This is also where any older/legacy rooms show up. Click a room name to expand it — you can add more IDs, download each student's CSV, download the whole room's CSV at once, delete just the collected data, or delete the room itself.

### Sessions & Feedback

- Click a student to see their sessions. Click a session to view the code/events and generate or manually write feedback for that specific session.
- Feedback is only visible to the student once you click **Publish**.

## 6. Student Panel

Go to `/student` on the server URL. Students log in with just their student ID (must be in a room's allowed list). They can see their sessions, published feedback, and use the AI hint chatbot (gives hints only, never full code answers).

## 7. VS Code Extension

Students use the [Student Tracker extension](https://github.com/mahihasan909-gif/student-tracker) to record and submit sessions. See that repo's README for extension setup instructions.
