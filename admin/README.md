# OpenPanel Admin CLI

An interactive CLI tool to help manage and lookup OpenPanel organizations, projects, and clients.

## Setup

First, install dependencies:

```bash
cd admin
pnpm install
```

## Usage

Run it from the repository root (it reads `DATABASE_URL` from `.env` or
`admin/.env`; in production, Neon's direct connection string):

```bash
pnpm admin
```

## Features

The CLI provides 4 focused lookup commands for easier navigation:

### 🏢 Lookup by Organization

Search and view detailed information about an organization.

- Fuzzy search across all organizations by name or ID
- Shows full organization details with all projects, clients, and members

### 📊 Lookup by Project

Search for a specific project and view its organization context.

- Fuzzy search across all projects by name or ID
- Highlights the selected project in the organization view
- Displays: `org → project`

### 🔑 Lookup by Client ID

Search for a specific client and view its full context.

- Fuzzy search across all clients by name or ID
- Highlights the selected client and its project
- Displays: `org → project → client`

### 📧 Lookup by Email

Search for a member by email address.

- Fuzzy search across all member emails
- Shows which organization(s) the member belongs to
- Displays member role (👑 owner, ⭐ admin, 👤 member)

**All lookups display:**
- Organization information (ID, name, subscription status, timezone, event usage)
- Organization members and their roles
- All projects with their settings (domain, CORS, event counts)
- All clients for each project (ID, name, type, credentials)
- Deletion warnings if scheduled

---

### 🔴 Delete Organization

Permanently delete an organization and all its data.

- Fuzzy search to find the organization
- Shows detailed preview of what will be deleted (projects, members, events)
- Requires **3 confirmations**:
  1. Initial confirmation
  2. Type organization name to confirm
  3. Final warning confirmation
- Schedules the deletion: the worker's hourly cron hands the organization to
  the ProjectDelete workflow, which removes the analytics data in chunks,
  then the projects and the organization

**Use when:**
- Removing organizations that are no longer needed
- Cleaning up test/demo organizations
- Handling deletion requests

**⚠️ WARNING:** This action is PERMANENT and cannot be undone!

**What gets deleted:**
- Organization record
- All projects and their settings
- All clients and credentials
- All events and analytics data (the `analytics` schema)
- All member associations
- All dashboards and reports

---

### 🔴 Delete User

Permanently delete a user account and remove them from all organizations.

- Fuzzy search by email or name
- Shows which organizations the user belongs to
- Shows if user created any organizations (won't delete those orgs)
- Requires **3 confirmations**:
  1. Initial confirmation
  2. Type user email to confirm
  3. Final warning confirmation

**Use when:**
- Removing user accounts at user request
- Cleaning up inactive accounts
- Handling GDPR/data deletion requests

**⚠️ WARNING:** This action is PERMANENT and cannot be undone!

**What gets deleted:**
- User account
- All auth sessions and tokens
- All memberships (removed from all orgs)
- All personal data

**What is NOT deleted:**
- Organizations created by the user (only the creator reference is removed)

## Environment Variables

Make sure you have the proper environment variables set up:
- `DATABASE_URL` - PostgreSQL connection string (Neon's direct URL in production)

## Development

The CLI uses:
- **jiti** - Direct TypeScript execution without build step
- **inquirer** - Interactive prompts
- **inquirer-autocomplete-prompt** - Fuzzy search functionality
- **chalk** - Colored terminal output
- **@openpanel/db** - Direct Prisma database access

