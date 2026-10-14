// Jira client service using jira.js

import { Version2Client, Version2Models } from 'jira.js';
import type { JiraConfig } from '../config/types.js';
import { markdownToJira, jiraToMarkdown } from '../utils/markdown-to-jira.js';

type Issue = Version2Models.Issue;
type Fields = Version2Models.Fields;

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  type: string;
  assignee?: string;
  /** The assignee's account id, so a caller can check WHO was assigned without comparing display names. */
  assigneeAccountId?: string;
  priority?: string;
  created: string;
  updated: string;
  description?: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  /** The status this transition leads to. A transition's name is not its destination ("Start Progress" -> "In Progress"). */
  to?: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
}

export class JiraService {
  private client: Version2Client;
  private config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = config;
    this.client = new Version2Client({
      host: config.host.startsWith('http') ? config.host : `https://${config.host}`,
      authentication: {
        basic: {
          email: config.email,
          apiToken: config.apiToken,
        },
      },
    });
  }

  /**
   * List issues with optional filters
   */
  async listIssues(options: {
    project?: string;
    status?: string;
    assignee?: string;
    limit?: number;
  } = {}): Promise<JiraIssue[]> {
    const project = options.project || this.config.defaultProject;
    const limit = options.limit || 20;

    let jql = project ? `project = ${project}` : '';

    if (options.status) {
      jql += jql ? ` AND ` : '';
      jql += `status = "${options.status}"`;
    }

    if (options.assignee) {
      jql += jql ? ` AND ` : '';
      jql += options.assignee === 'me'
        ? `assignee = currentUser()`
        : `assignee = "${options.assignee}"`;
    }

    jql += ' ORDER BY updated DESC';

    return this.searchJql(jql, limit);
  }

  /**
   * Search issues using JQL
   */
  async searchJql(jql: string, limit: number = 20): Promise<JiraIssue[]> {
    const result = await this.client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
      jql,
      maxResults: limit,
      fields: ['summary', 'status', 'issuetype', 'assignee', 'priority', 'created', 'updated'],
    });

    return (result.issues || []).map((issue: Issue) => {
      const fields = issue.fields as Fields;
      return {
        key: issue.key,
        summary: fields.summary || '',
        status: fields.status?.name || '',
        type: fields.issuetype?.name || '',
        assignee: fields.assignee?.displayName,
        priority: fields.priority?.name,
        created: fields.created || '',
        updated: fields.updated || '',
      };
    });
  }

  /**
   * Create a new issue
   */
  async createIssue(options: {
    summary: string;
    project?: string;
    type?: string;
    description?: string;
    priority?: string;
  }): Promise<{ key: string; id: string }> {
    const project = options.project || this.config.defaultProject;
    if (!project) {
      throw new Error('Project key is required');
    }

    // Convert markdown description to JIRA wiki markup
    const jiraDescription = options.description
      ? markdownToJira(options.description)
      : undefined;

    try {
      const result = await this.client.issues.createIssue({
        fields: {
          project: { key: project },
          summary: options.summary,
          issuetype: { name: options.type || 'Task' },
          description: jiraDescription,
          priority: options.priority ? { name: options.priority } : undefined,
        },
      });

      return { key: result.key || 'unknown', id: result.id || 'unknown' };
    } catch (err: any) {
      // Extract detailed error message from JIRA API response
      const errorDetails = err?.response?.data?.errors || err?.response?.data || err?.message || err;
      throw new Error(`JIRA API Error: ${JSON.stringify(errorDetails)}`);
    }
  }

  /**
   * Update issue fields (summary, description, priority, labels)
   * Note: status changes require updateStatus (transitions), assignee uses assignIssue
   */
  async updateIssue(issueKey: string, fields: {
    summary?: string;
    description?: string;
    priority?: string;
    labels?: string[];
  }): Promise<void> {
    const updateFields: Record<string, unknown> = {};

    if (fields.summary) {
      updateFields.summary = fields.summary;
    }
    if (fields.description !== undefined) {
      // Convert markdown description to JIRA wiki markup
      updateFields.description = fields.description ? markdownToJira(fields.description) : '';
    }
    if (fields.priority) {
      updateFields.priority = { name: fields.priority };
    }
    if (fields.labels) {
      updateFields.labels = fields.labels;
    }

    if (Object.keys(updateFields).length === 0) {
      throw new Error('No fields to update');
    }

    await this.client.issues.editIssue({
      issueIdOrKey: issueKey,
      fields: updateFields,
    });
  }

  /**
   * Get available transitions for an issue
   */
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.client.issues.getTransitions({ issueIdOrKey: issueKey });
    return (result.transitions || []).map((t) => ({
      id: t.id!,
      name: t.name!,
      ...(t.to?.name ? { to: t.to.name } : {}),
    }));
  }

  /**
   * Update issue status (transition)
   */
  /**
   * Move an issue to `status`, by the transition whose DESTINATION is that status, or failing that whose name is
   * it. Returns the status the transition leads to, which is what a caller should verify against.
   */
  async updateStatus(issueKey: string, status: string): Promise<string> {
    const transitions = await this.getTransitions(issueKey);
    const wanted = status.toLowerCase();
    const transition = transitions.find((t) => t.to?.toLowerCase() === wanted)
      ?? transitions.find((t) => t.name.toLowerCase() === wanted);

    if (!transition) {
      const available = transitions.map((t) => (t.to && t.to !== t.name ? `${t.name} (-> ${t.to})` : t.name)).join(', ');
      throw new Error(`Transition "${status}" not found. Available: ${available}`);
    }

    await this.client.issues.doTransition({
      issueIdOrKey: issueKey,
      transition: { id: transition.id },
    });
    return transition.to ?? transition.name;
  }

  /**
   * Add a comment to an issue
   */
  async addComment(issueKey: string, body: string): Promise<string> {
    // Convert markdown to JIRA wiki markup
    const jiraBody = markdownToJira(body);

    const result = await this.client.issueComments.addComment({
      issueIdOrKey: issueKey,
      comment: jiraBody,
    });
    return result.id || 'unknown';
  }

  /**
   * Assign an issue to a user
   */
  async assignIssue(issueKey: string, assignee: string): Promise<{ accountId: string; displayName: string }> {
    // First search for user to get accountId
    const users = await this.client.userSearch.findAssignableUsers({
      query: assignee,
      issueKey: issueKey,
      maxResults: 5,
    });

    if (!users || users.length === 0) {
      throw new Error(`User "${assignee}" not found or cannot be assigned to this issue`);
    }

    // An exact display-name match wins over the search's first hit: "Dana" and "Dana Rivera" can
    // both be in the results, and the first is not necessarily the person asked for.
    const wanted = assignee.trim().toLowerCase();
    const user = users.find((u) => (u.displayName ?? '').trim().toLowerCase() === wanted) ?? users[0];
    // Without an account id the assignment cannot be made, and a later "is it this person?" check would compare
    // undefined with undefined and call an unassigned issue a success.
    if (!user?.accountId) {
      throw new Error(`User "${assignee}" was found without an account id; it cannot be assigned`);
    }
    await this.client.issues.assignIssue({
      issueIdOrKey: issueKey,
      accountId: user.accountId!,
    });

    return { accountId: user.accountId!, displayName: user.displayName ?? assignee };
  }

  /**
   * List all users assignable to a project
   */
  async listAssignableUsers(project?: string, limit: number = 50): Promise<JiraUser[]> {
    const projectKey = project || this.config.defaultProject;
    if (!projectKey) {
      throw new Error('Project key is required');
    }

    const users = await this.client.userSearch.findAssignableUsers({
      project: projectKey,
      maxResults: limit,
    });

    return (users || []).map((user) => ({
      accountId: user.accountId || '',
      displayName: user.displayName || '',
      emailAddress: user.emailAddress,
      active: user.active ?? true,
    }));
  }

  /**
   * Get issue details
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    const issue = await this.client.issues.getIssue({
      issueIdOrKey: issueKey,
      fields: ['summary', 'status', 'issuetype', 'assignee', 'priority', 'created', 'updated', 'description'],
    });

    // Convert JIRA wiki markup description to markdown for display
    const rawDescription = (issue.fields?.description as string) || '';
    const description = rawDescription ? jiraToMarkdown(rawDescription) : undefined;

    return {
      key: issue.key!,
      summary: issue.fields?.summary || '',
      status: (issue.fields?.status as any)?.name || '',
      type: (issue.fields?.issuetype as any)?.name || '',
      assignee: (issue.fields?.assignee as any)?.displayName,
      assigneeAccountId: (issue.fields?.assignee as any)?.accountId,
      priority: (issue.fields?.priority as any)?.name,
      created: issue.fields?.created || '',
      updated: issue.fields?.updated || '',
      description,
    };
  }
}

export default JiraService;
