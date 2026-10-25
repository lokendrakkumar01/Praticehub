# PracticeHub

PracticeHub is a student performance dashboard for tracking manually verified Aptitude and Mock Interview results. Sunstone remains the practice platform; PracticeHub stores scores entered by the coordinator after screenshot review.

## Run locally

1. Install Node.js 20 or later and MongoDB (local or Atlas).
2. Copy `.env.example` to `.env`, set `MONGODB_URI`, a random `SESSION_SECRET`, and `APP_ORIGIN`.
3. Configure the three Cloudinary variables to enable private screenshot uploads.
4. Run `npm install`, then `npm run server` in one terminal and `npm run dev` in another.
5. Create the first coordinator by setting up a user through a one-time bootstrap script or a secured deployment provisioning process. The public API intentionally has no open registration route.

For a production build, run `npm run build`; deploy the static `dist` directory and Express service to Render, configure the same environment variables, and use a MongoDB Atlas database. Never commit `.env` or expose Cloudinary credentials in the browser.

## Data and permissions

MongoDB models cover users, students, practice records, competitions, winner approvals, and immutable audit events. Sessions are stored in MongoDB when configured. Student records are private to the linked student account; students can read their own records and cannot mutate scores. Faculty can review and approve winner proposals, while only coordinators can manage students and scores. Only published records count toward leaderboard results. Scores are normalized to percentages before comparison and ties are broken by verified attempt count.

CSV import accepts columns `studentId`, `fullName`, `rollNumber`, `batch`, `email`, and `enrollmentStatus` (common display-name alternatives are recognized). Student ID and roll number have unique database indexes to prevent duplicate imports. CSV report export is available to coordinator and faculty roles.

The initial dashboard UI deliberately labels its visual demo values as sample data. The Express API is provided for database-backed use; configure the frontend API origin and authenticated user bootstrap as part of deployment before treating any values as live.
