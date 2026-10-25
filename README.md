# PracticeHub

PracticeHub is a student performance dashboard for tracking manually verified Aptitude and Mock Interview results. Sunstone remains the practice platform; PracticeHub stores scores entered by the coordinator after screenshot review.

## Run locally

1. Install Node.js 20 or later and MongoDB (local or Atlas).
2. Copy `.env.example` to `.env`, set `MONGODB_URI`, a random `SESSION_SECRET`, and `APP_ORIGIN`.
3. Configure the three Cloudinary variables to enable private screenshot uploads.
4. Run `npm install`, then `npm run server` in one terminal and `npm run dev` in another.
5. Create the first coordinator by setting up a user through a one-time bootstrap script or a secured deployment provisioning process. The public API intentionally has no open registration route.

## Deploy to Render and MongoDB Atlas

The included `render.yaml` describes a Render web service for the Express API and a static site for the Vite frontend. Push the project to GitHub, then in Render choose **New → Blueprint**, connect this repository, and apply the Blueprint. Render will ask for the secret environment variables marked `sync: false`.

1. In MongoDB Atlas, create a project and cluster. Under **Database Access**, create an application database user and save its password. Under **Network Access**, allow connections from Render (for a quick initial setup, `0.0.0.0/0`; restrict this later if you have stable egress IPs). Choose **Connect → Drivers** and copy the URI. Replace the password placeholder with the database user's URL-encoded password and use a database name such as `practicehub`.
2. In Render's `practicehub-api` environment, set `MONGODB_URI` to the Atlas URI, `APP_ORIGIN` to the deployed frontend origin (for example `https://practicehub-frontend.onrender.com`), and `CLOUDINARY_URL` to the Cloudinary URL from your Cloudinary console. Keep all credential values in Render's secret environment settings; never commit them or put them in a `VITE_*` variable. Render generates `SESSION_SECRET` for this Blueprint.
3. Keep `VITE_API_URL` set to the API's full `/api` URL. If Render assigns a different API hostname, update this value in the frontend service's environment and redeploy it. If the frontend hostname differs from the example, update `APP_ORIGIN` on the API service and redeploy the API.
4. Wait for both Render services to finish deploying. Check `https://<api-host>/api/health` and confirm the database reports `connected`. Open the static site URL to view the dashboard.
5. After successful setup, tighten MongoDB network access where practical and rotate any credential that may have been shared outside your password manager.

To create the first coordinator, set `ADMIN_BOOTSTRAP_KEY` as a Render secret, deploy the backend, then open `/Admin/setup` on the frontend and submit the key with the coordinator name, email, and a 12+ character password. The endpoint only works while no coordinator exists. Remove the bootstrap secret from Render after setup. Admins can add students from Student Directory; students sign in at `/student/login` using the registered name and phone number. The current name-plus-phone sign-in is a simple identity check, not phone verification; use OTP verification before relying on it for sensitive student data.

For direct paths such as `/Admin/login` and `/student/login` to load after a refresh, add a Static Site rewrite in Render: source `/*`, destination `/index.html`, action `Rewrite`.

**Deployment limitation:** the current frontend is a UI preview and still renders clearly labeled sample records; it does not yet call the API. Deploying these services makes the API available, but it does not make the displayed dashboard data live. A coordinator account also needs to be provisioned securely before role-protected endpoints can be used; there is no public signup route. Complete the frontend API integration and secure coordinator bootstrap before using this with student records.

## Data and permissions

MongoDB models cover users, students, practice records, competitions, winner approvals, and immutable audit events. Sessions are stored in MongoDB when configured. Student records are private to the linked student account; students can read their own records and cannot mutate scores. Faculty can review and approve winner proposals, while only coordinators can manage students and scores. Only published records count toward leaderboard results. Scores are normalized to percentages before comparison and ties are broken by verified attempt count.

CSV import accepts columns `studentId`, `fullName`, `rollNumber`, `batch`, `email`, and `enrollmentStatus` (common display-name alternatives are recognized). Student ID and roll number have unique database indexes to prevent duplicate imports. CSV report export is available to coordinator and faculty roles.

The initial dashboard UI deliberately labels its visual demo values as sample data. The Express API is provided for database-backed use; configure the frontend API origin and authenticated user bootstrap as part of deployment before treating any values as live.
