# Communit

Communit is a browser-based team communication app. It lets people sign up, log in, chat one-to-one or in groups, send files and voice messages, make audio calls, and run video meetings with screen sharing, annotations, and a shared whiteboard.

This project uses a Node.js and Express server, Socket.IO for live updates, PostgreSQL with Prisma for data storage, and plain HTML/CSS/JavaScript for the interface.

## What it does

Communit is built to handle day-to-day collaboration in one place:

- Create direct chats or group rooms
- Send text messages, files, images, and voice notes
- Edit, delete, pin, block, or leave conversations where allowed
- Make real-time audio calls
- Start video meetings with screen sharing
- Draw on a shared whiteboard during meetings
- Save contact nicknames so people can rename users in a way that makes sense to them

## Main features

### Messaging

- Direct messages and group chats
- Typing indicators and live message updates
- Message replies, edits, and deletes
- File uploads through the app
- Voice message recording and playback
- Mobile-friendly chat interactions

### Calls and meetings

- Audio calling with a floating mini call window
- WebRTC-based video meetings
- Screen sharing in meetings
- Meeting invite notifications
- Host controls for meeting management

### Whiteboard and annotations

- Shared drawing board for meetings
- Shapes, text, brush tools, and eraser tools
- Undo and redo support
- Screen annotations on top of shared content

### User experience

- Login and registration pages
- Sidebar for rooms, contacts, and actions
- Responsive layout for desktop and mobile screens
- Custom display names for contacts

## Pages in the project

- `index.html` - landing page
- `login.html` - sign in page
- `register.html` - account creation page
- `dashboard.html` - main messaging screen
- `meeting.html` - full meeting room
- `room.html` - room view

## Project structure

- `server.js` - starts the Express and Socket.IO server
- `src/routes/` - API routes for auth, rooms, meetings, and files
- `src/handlers/` - real-time event handlers
- `src/middleware/` - authentication and response formatting helpers
- `prisma/schema.prisma` - database models
- `public/` - frontend HTML, CSS, JavaScript, images, and uploads

## Requirements

Before running the app, install:

- Node.js 20 or newer
- npm 10 or newer
- PostgreSQL

## How to run it locally

### 1. Install dependencies

Open a terminal in the project folder and run:

```bash
npm install
```

### 2. Create your environment file

Copy `.env.example` to `.env` and fill in your own values.

Minimum settings:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/communit
JWT_SECRET=your-secret-key-here
PORT=3000
```

Important:

- Keep `.env` private
- Do not upload real passwords or tokens to GitHub

### 3. Prepare the database

Create the PostgreSQL database first, then run:

```bash
npx prisma db push
npx prisma generate
```

### 4. Start the app

Run the development server:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Optional checks

If you want to test the setup, run:

```bash
node test-connections.js
```

This checks the database connection, server startup, Socket.IO, and JWT configuration.

## GitHub upload ready

This repository is already set up to be uploaded to GitHub safely:

- `node_modules/` is ignored
- `.env` files are ignored
- editor and OS files are ignored
- uploaded user files in `public/uploads/` are ignored, while `.gitkeep` keeps the folder in the repo
- `.env.example` is included so other people know which environment values to create

Before pushing to GitHub, make sure your local `.env` file does not contain any secrets you do not want to share.

## In plain words

If you are not technical, the short version is:

1. Install Node.js and PostgreSQL.
2. Install the project packages with `npm install`.
3. Create a `.env` file using `.env.example`.
4. Prepare the database with Prisma.
5. Start the server with `npm run dev`.
6. Open the website in your browser.

## Notes

- `npm run build` does not create a production build for this project; the app runs directly from the Node.js server.
- The app expects PostgreSQL to be available before login, registration, and messaging can work.
* **Active WebRTC Video Meeting:**
  ![Video Meeting Screen](public/images/meeting.png)

### 4. Collaborative Vector Whiteboard
* **Multi-user Shared Sketchpad (Drawing toolbars, brush scales, shapes, lasso selections, & actions):**
  ![Whiteboard Canvas Screen](public/images/whiteboard.png)
