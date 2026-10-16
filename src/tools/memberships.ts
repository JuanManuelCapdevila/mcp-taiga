import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListTool } from "./crudFactory.js";

interface MembershipSummary {
  id: number;
  user: number | null;
  user_extra_info?: { username: string; full_name_display: string } | null;
  role_name: string;
  email: string;
  is_admin: boolean;
}

function renderListItem(item: MembershipSummary): string {
  const who = item.user_extra_info ? `${item.user_extra_info.full_name_display} (@${item.user_extra_info.username})` : item.email + " (pending invite)";
  return `## ${who}\n- **Membership ID**: ${item.id} | **Role**: ${item.role_name} | **Admin**: ${item.is_admin}\n`;
}

export function registerMembershipTools(server: McpServer): void {
  registerListTool<MembershipSummary>(server, {
    toolName: "taiga_list_memberships",
    title: "Taiga: List Project Memberships",
    resourcePath: "/memberships",
    markdownTitle: "Project Members",
    renderItem: renderListItem,
    extraFilters: {
      role: z.number().int().optional().describe("Filter by role ID"),
    },
    buildFilterParams: (f) => f,
    description:
      "Lists the members of a Taiga project, including their role (which determines their permissions in that " +
      "project) and whether they are a pending invite.\n\n" +
      "Args:\n" +
      "  - project (number | string, required)\n" +
      "  - role (number, optional): filter by role ID\n" +
      "  - page, page_size, response_format\n\n" +
      "Returns: paginated list of members with user info, role name, admin flag.\n\n" +
      "Use when: \"who is on project X\" / \"what role does Maria have in project X\" — useful to understand what " +
      "actions a given user (including the MCP's own authenticated user) is allowed to perform.",
  });
}
