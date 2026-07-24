'use strict';

/**
 * Onboarding tasks for new users.
 * Each task is created with the admin as owner and assigned to the new user.
 * Tasks are standalone (no project) so they appear in the user's Tasks list immediately.
 */

const ONBOARDING_TASKS = [
  {
    name: '👋 Welcome — Change Your Temporary Password',
    details: `Your account was created with a temporary password. The first thing you should do is set a personal one.

How: Click your name in the top-right corner → Profile → scroll to "Change Password". Enter your temporary password as the current password, then choose a strong new one (8+ characters, mixed case, a number and a symbol).

Your password is private — nobody else can see it, and it is stored securely.`,
  },
  {
    name: '🏠 Explore Your Dashboard',
    details: `The Dashboard is your personal home base in Samyou CRM.

What you see:
• Pipeline stats — total open deals and won revenue (scoped to your records).
• Activity calendar — your upcoming and recent activities.
• Recent comments — notes and messages you've posted on tasks, projects, and activities.

Everything on the dashboard is scoped to you. You will only see records you own or have been assigned to.

Tip: The Tasks menu item shows a blue badge with the number of your open tasks — keep an eye on it.`,
  },
  {
    name: '🏢 Add Your First Company',
    details: `Companies are the foundation of the CRM. Clients, prospects, and partners all live here.

Each company can have:
• Contacts — the people you work with there.
• Deals — sales opportunities and their value.
• Projects — ongoing work for that client.
• Activities — a log of every call, email, and meeting.
• Documents — uploaded contracts and files.

How to add one: Go to Companies (top menu) → click "Add company" → fill in the name, industry, status, and website.

After saving, you can link contacts, open deals, and start projects directly from the company profile.`,
  },
  {
    name: '👤 Add a Contact to a Company',
    details: `Contacts are the people at your companies — decision-makers, technical leads, or billing contacts.

How to add one:
1. Open a company page.
2. Click "Add" in the Contacts section.
3. Fill in their name, title, email, and phone.

Contacts can be linked to activities (as attendees) and to deals (as the primary contact). You can view all contact history from the contact's own profile page.`,
  },
  {
    name: '💰 Create a Deal in the Pipeline',
    details: `Deals track sales opportunities — each with a value, a stage, and an expected close date.

Stages in Samyou CRM:
Prospect → Proposal Sent → Negotiation → Closed Won / Closed Lost

How to create a deal:
1. Open a company page.
2. Click "New" in the Deals section.
3. Set the name, stage, amount (in USD), and close date.
4. Link it to a contact if you have one.

The deal will appear immediately on the Pipeline board (top menu → Pipeline). You can drag it between columns or edit the stage from the deal page.`,
  },
  {
    name: '📁 Start a Project',
    details: `Projects represent ongoing work for a client. They live under a company and bring together tasks, files, comments, and products in one place.

How to create one:
1. Open a company page.
2. Click "New" next to Projects.
3. Give it a name, status, and description.
4. Optionally link it to products from the catalog.

Once created, you can:
• Add tasks with deadlines and assignees.
• Post comments and notes in a shared thread.
• Attach files (contracts, specs, drawings).
• Log activities connected to the project.

Projects are visible to everyone in your group (Managers) or just you and assigned users (Staff).`,
  },
  {
    name: '✅ Create and Manage Tasks',
    details: `Tasks are the work items inside projects. They keep the team aligned on what needs to be done and by when.

Each task has:
• Status — To Do / In Progress / Review / Completed.
• Deadline — with a visual deadline history log if it changes.
• Assignees — team members responsible for the work.
• Auditor — a reviewer who verifies completion.
• Comments & files — a thread for updates and attachments.

How to create a task:
1. Open a project.
2. Click "Add task" in the Tasks section.
3. Set the name, deadline, and assign it to someone.

Tip: Assigned users see a badge count on the Tasks menu. Completing a task clears it from the badge count.`,
  },
  {
    name: '📞 Log an Activity (Call, Email, Meeting)',
    details: `Activities record every client interaction so nothing gets lost.

Supported types: Call · Email · LinkedIn · Meeting · Demo

How to log one:
1. Open a company page (or project page).
2. Click "New" next to Activities.
3. Choose the type, date, and add a short description.
4. Link attendees (contacts) and related projects.

After the interaction, you can edit the activity to record the result (e.g. "Positive", "Follow-up needed") and the outcome date.

Activities also support inbound emails — if your admin has set up the email integration, replies sent to a special address are automatically logged as activity threads.`,
  },
  {
    name: '🔍 Understand Roles and What You Can See',
    details: `Samyou CRM uses a 3-level permission model:

Admin — full access to every record in the system. Can manage users and settings.

Manager — sees all records in their assigned group(s). Can assign users to records and see team-wide pipeline and activity.

Staff — sees only records they personally own or have been explicitly assigned to. Cannot see other users' clients or deals unless assigned.

Your role is shown in your profile (click your name → Profile → role badge at the top).

If you believe you should have access to a record and don't see it, contact your Admin — they can assign you to it.`,
  },
  {
    name: '📦 Browse the Product Catalog',
    details: `The Products section (top menu → Products) is a catalog of the services and hardware your company offers.

Each product has:
• Category and phase (electrical specs for hardware).
• A photo and notes.
• Links to projects where it is being used.

Products are linked to projects when you create or edit a project. This lets you track which clients use which products and generate cross-references between the product catalog and project pipeline.

You do not need to add products to use the CRM — they are optional but useful for technical or product-led businesses.`,
  },
];

/**
 * Create a full set of onboarding tasks for a newly created user.
 * @param {object} crm        – the CRM service module
 * @param {string} adminId    – UUID of the admin who is creating the user (task owner)
 * @param {string} newUserId  – UUID of the newly created user (task assignee)
 */
async function createOnboardingTasks(crm, adminId, newUserId) {
  for (const tmpl of ONBOARDING_TASKS) {
    const task = await crm.createTask({
      name:        tmpl.name,
      description: tmpl.details,
      status:      'To Do',
      ownerId:     adminId,
    });
    await crm.setTaskAssignees({ taskId: task.id, userIds: [newUserId] });
  }
}

module.exports = { createOnboardingTasks, ONBOARDING_TASKS };
