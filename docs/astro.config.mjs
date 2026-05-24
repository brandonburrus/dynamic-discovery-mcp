import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeFlexoki from "starlight-theme-flexoki";

export default defineConfig({
	site: "https://dynamicmcp.tools",
	integrations: [
		starlight({
			title: "dynmcp",
			description:
				"Context management for MCP enabling dynamic tool discovery",
			favicon: "/favicon.svg",
			logo: {
				light: "./src/assets/mcp-icon-light.svg",
				dark: "./src/assets/mcp-icon-dark.svg",
				alt: "MCP",
			},
			plugins: [starlightThemeFlexoki({
        accentColor: "magenta",
      })],
			customCss: ["./src/styles/custom.css"],
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/brandonburrus/dynamic-discovery-mcp",
				},
				{
					icon: "npm",
					label: "npm",
					href: "https://www.npmjs.com/package/dynmcp",
				},
			],
			editLink: {
				baseUrl:
					"https://github.com/brandonburrus/dynamic-discovery-mcp/edit/main/docs/",
			},
			lastUpdated: true,
			sidebar: [
				{
					label: "Start Here",
					items: [
						{ label: "Introduction", slug: "start/introduction" },
						{ label: "Installation", slug: "start/installation" },
						{ label: "Quick Start", slug: "start/quick-start" },
					],
				},
				{
					label: "Guides",
					items: [
						{ label: "Single MCP Mode", slug: "guides/single-mcp" },
						{ label: "Config File Mode", slug: "guides/config-file" },
						{ label: "Dynamic Discovery", slug: "guides/dynamic-discovery" },
						{
							label: "Environment Variables",
							slug: "guides/environment-variables",
						},
						{
							label: "OAuth Authentication",
							slug: "guides/oauth-authentication",
						},
						{
							label: "Writing Descriptions",
							slug: "guides/writing-descriptions",
						},
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "CLI", slug: "reference/cli" },
						{ label: "Config Schema", slug: "reference/config-schema" },
						{ label: "Transports", slug: "reference/transports" },
						{ label: "OAuth", slug: "reference/oauth" },
						{ label: "Diagnostics", slug: "reference/diagnostics" },
						{
							label: "Tools",
							collapsed: false,
							items: [
								{ label: "discover_tool", slug: "reference/tools/discover-tool" },
								{ label: "use_tool", slug: "reference/tools/use-tool" },
								{ label: "load_mcp", slug: "reference/tools/load-mcp" },
							],
						},
					],
				},
			],
		}),
	],
});
