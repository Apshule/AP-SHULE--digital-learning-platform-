# APSHULE MANAGEMENT SYSTEM — Primary Account Map

## Purpose

This map documents the primary school-management experience visible in the APSHULE MANAGEMENT SYSTEM reference screens and the corresponding APSHULE Education workspace. It intentionally contains no passwords, session tokens, private school records, or account recovery instructions.

## Reference material

- `Screenshot_20260918-191303_1789748505865.png` — public landing/options state.
- `Screenshot_20260918-191313_1789748505900.png` — primary login state on a phone.
- `Screenshot_20260918-191343_1789748505943.png` — primary login state at a wider viewport.
- `Screenshot_20260918-191038_1789748505980.png` — Video Meetings announcement modal.
- `Screenshot_20260918-191055_1789748506030.png` — primary school dashboard.
- Remaining supplied screenshots — supporting responsive states and entry-flow references.

## Primary flow

1. **Public entry** — APSHULE MANAGEMENT SYSTEM branding, school-fees and IT-services options, Login, Parents Portal, Students Portal, and resource links such as Notice Board, Jobs, Pricing, and Support.
2. **Primary login** — account context, email-or-username field, password field, sign-in action, and a “back to options” path. The right-hand panel communicates “Transforming Schools,” EAT time, support promises, and product announcements.
3. **School dashboard** — institution header, school contact context, role badge, alerts/settings affordances, and a dashboard landing view.
4. **Dashboard insights** — learners by level, gender distribution, class-size distribution, system status, performance metrics, and quick statistics.
5. **Operations navigation** — learner register, ID cards, admission letters, graduation certificates, report cards, attendance, SMS, and profile/settings.
6. **Announcement state** — a modal for Video Meetings with staff meetings, parent meetings, live lessons/interviews, and parent/student portal access.
7. **Install App state** — an install prompt or install affordance that keeps the school workspace available from a phone.

## Visual language

- Blue-to-purple gradients for entry and announcement surfaces.
- White cards with rounded corners, restrained borders, and soft shadows.
- Dark navy navigation and compact role/status badges.
- Blue, green, orange, violet, and pink accents for metric categories and charts.
- Large, readable dashboard numbers with donut and horizontal-bar visualizations.
- Mobile behavior collapses the marketing panel and turns the sidebar into a drawer.

## APSHULE implementation boundary

The `/education/` route adapts these visible patterns inside APSHULE’s Education area. It is a credential-free preview and sends live users to the existing APSHULE secure login. Sample dashboard values are clearly marked as preview data. Connecting the modules to live, institution-scoped records is a separate follow-up requiring confirmed role permissions and API contracts.