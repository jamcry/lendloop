# Take-home assignment (Step 1 of the process)

Please complete a take-home assignment. You are allowed to use LLMs to write code.
To ensure that your work will not be used at Fluence, we've made it unrelated to
healthcare:

## Build "LendLoop": a neighborhood tool-lending board with automated workflows

A simple app where neighbors list tools they are willing to lend, request to
borrow from each other, and receive automated notifications and reminders handled
by n8n.

## Stack

- Next.js (App Router)
- Clerk for authentication
- Convex for data + backend logic
- n8n (self-hosted via Docker or n8n Cloud) for workflow automation
- TypeScript

## Requirements

### Public page

- The fictional company name is LendLoop.
- Short tagline, e.g. "Borrow what you need. Lend what you don't."

Show:

- A read-only list of available tools (name and category only, no owner details),
  pulled from Convex.
- A "Sign in to lend or borrow" button wired to Clerk.

### Authenticated experience

Only signed-in users can:

- List a tool with:
  - name
  - category (power tools, garden, kitchen, camping, etc.)
  - condition
  - short description
- Request to borrow a tool for a date range.
- Approve or decline requests on their own tools.
- Mark a loan as returned.

Show:

- All tools with availability status, filterable by category.
- "My listings", "My requests", and "Incoming requests" views.
- Nice, minimal layout.

### Roles & rules

Have two roles:

- **admin**:
  - Can remove any listing, view all loans, and mark a lender as "Trusted
    Lender".
- **user**:
  - Can create, edit, and delete only their own listings, and act only on
    requests involving their own tools or their own borrowing.

Implement the above role-based access control with best practices, enforced in
Convex functions, not only in the UI.

### Automation with n8n

Build at least two n8n workflows:

- **Request notification**: when a borrow request is created or changes status,
  Convex calls an n8n Webhook. The workflow notifies the relevant user (email,
  Slack, Discord, or a logged mock notification is fine) using only the fields it
  needs.
- **Overdue reminders**: a scheduled workflow runs daily, fetches overdue loans
  from a Convex HTTP endpoint, sends a reminder to each borrower, and writes the
  reminder status back to Convex.

Secure the integration in both directions:

- Sign webhook payloads (e.g. HMAC with a shared secret) and verify signatures on
  the receiving side.
- Keep secrets in environment variables and n8n credentials, never in code or
  exported workflow JSON.
- Make write-backs idempotent so retries do not create duplicate records or
  reminders.
- Handle failures with retries and an error workflow (or equivalent) so failed
  runs are visible and never fail silently.

(Bonus) Show recent automation activity on each loan in the app, e.g. "Reminder
sent 2 days ago".

## Deliverables

- A GitHub repository with the app source code.
- Exported n8n workflow JSON files in the repository.
- A README covering local setup (including n8n, e.g. a docker-compose file),
  environment variables, architecture, and your security and data-minimization
  decisions.
- A short note on what you would change to run this in production.

## We evaluate

- Code structure and clarity
- Security-minded thinking
- UX and practicality
- Integration design, reliability, and error handling (n8n)
- Documentation and reasoning
