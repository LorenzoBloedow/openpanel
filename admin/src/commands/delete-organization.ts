import { db } from '@openpanel/db';
import chalk from 'chalk';
import fuzzy from 'fuzzy';
import inquirer from 'inquirer';
import autocomplete from 'inquirer-autocomplete-prompt';

// Register autocomplete prompt
inquirer.registerPrompt('autocomplete', autocomplete);

interface OrgSearchItem {
  id: string;
  name: string;
  displayText: string;
}

export async function deleteOrganization() {
  console.log(chalk.red('\n🗑️  Delete Organization\n'));
  console.log(
    chalk.yellow(
      '⚠️  WARNING: This will permanently delete the organization and all its data!\n',
    ),
  );
  console.log('Loading organizations...\n');

  const organizations = await db.organization.findMany({
    include: {
      projects: true,
      members: {
        include: {
          user: true,
        },
      },
    },
    orderBy: {
      name: 'asc',
    },
  });

  if (organizations.length === 0) {
    console.log(chalk.red('No organizations found.'));
    return;
  }

  const searchItems: OrgSearchItem[] = organizations.map((org) => ({
    id: org.id,
    name: org.name,
    displayText: `${org.name} ${chalk.gray(`(${org.id})`)} ${chalk.cyan(`- ${org.projects.length} projects, ${org.members.length} members`)}`,
  }));

  const searchFunction = async (_answers: unknown, input = '') => {
    const fuzzyResult = fuzzy.filter(input, searchItems, {
      extract: (item: OrgSearchItem) => `${item.name} ${item.id}`,
    });

    return fuzzyResult.map((result: fuzzy.FilterResult<OrgSearchItem>) => ({
      name: result.original.displayText,
      value: result.original,
    }));
  };

  const { selectedOrg } = (await inquirer.prompt([
    {
      type: 'autocomplete',
      name: 'selectedOrg',
      message: 'Search for an organization to delete:',
      source: searchFunction,
      pageSize: 15,
    },
  ])) as { selectedOrg: OrgSearchItem };

  // Fetch full organization details
  const organization = await db.organization.findUnique({
    where: {
      id: selectedOrg.id,
    },
    include: {
      projects: {
        include: {
          clients: true,
        },
      },
      members: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!organization) {
    console.log(chalk.red('Organization not found.'));
    return;
  }

  // Display what will be deleted
  console.log(chalk.red('\n⚠️  YOU ARE ABOUT TO DELETE:\n'));
  console.log(`  ${chalk.bold('Organization:')} ${organization.name}`);
  console.log(`  ${chalk.gray('ID:')} ${organization.id}`);
  console.log(`  ${chalk.gray('Projects:')} ${organization.projects.length}`);
  console.log(`  ${chalk.gray('Members:')} ${organization.members.length}`);

  if (organization.projects.length > 0) {
    console.log(chalk.red('\n  Projects that will be deleted:'));
    for (const project of organization.projects) {
      console.log(
        `    - ${project.name} ${chalk.gray(`(${project.eventsCount.toLocaleString()} events, ${project.clients.length} clients)`)}`,
      );
    }
  }

  if (organization.members.length > 0) {
    console.log(chalk.red('\n  Members who will lose access:'));
    for (const member of organization.members) {
      const email = member.user?.email || member.email || 'Unknown';
      console.log(`    - ${email} ${chalk.gray(`(${member.role})`)}`);
    }
  }

  console.log(
    chalk.red(
      '\n⚠️  This will delete ALL projects, clients, events, and data associated with this organization!',
    ),
  );

  // First confirmation
  const { confirmFirst } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmFirst',
      message: chalk.red(
        `Are you ABSOLUTELY SURE you want to delete "${organization.name}"?`,
      ),
      default: false,
    },
  ]);

  if (!confirmFirst) {
    console.log(chalk.yellow('\nDeletion cancelled.'));
    return;
  }

  // Second confirmation - type organization name
  const { confirmName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'confirmName',
      message: `Type the organization name "${organization.name}" to confirm deletion:`,
    },
  ]);

  if (confirmName !== organization.name) {
    console.log(
      chalk.red('\n❌ Organization name does not match. Deletion cancelled.'),
    );
    return;
  }

  // Final confirmation
  const { confirmFinal } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmFinal',
      message: chalk.red(
        'FINAL WARNING: This action CANNOT be undone. Delete now?',
      ),
      default: false,
    },
  ]);

  if (!confirmFinal) {
    console.log(chalk.yellow('\nDeletion cancelled.'));
    return;
  }

  console.log(chalk.red('\n🗑️  Deleting organization...\n'));

  try {
    // Scheduled, not deleted here: the worker's hourly cron starts the
    // ProjectDelete workflow for it, which deletes the projects' analytics
    // data in chunks, then the projects and the organization.
    console.log(chalk.yellow('Scheduling the organization for deletion...'));
    await db.organization.update({
      where: { id: organization.id },
      data: { deleteAt: new Date() },
    });
    console.log(chalk.green('✓ Organization scheduled for deletion'));

    console.log(chalk.green('\n✅ Organization deletion scheduled!'));
    console.log(
      chalk.gray(
        `Scheduled: ${organization.name} with ${organization.projects.length} projects and ${organization.members.length} members`,
      ),
    );
    console.log(
      chalk.gray(
        '\nNote: the worker deletes it within the hour (its analytics data first, then the projects and the organization).',
      ),
    );
  } catch (error) {
    console.error(chalk.red('\n❌ Error deleting organization:'), error);
    throw error;
  }
}
