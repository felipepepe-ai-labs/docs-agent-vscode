import { ProjectContext } from './project-context';

export interface DocType {
  id:          string;
  label:       string;
  detail:      string;
  category:    string;
  outputPath:  string;       // relative to workspace root
  prompt:      (ctx: ProjectContext) => { system: string; user: string };
}

// ── Shared preamble injected into every system prompt ─────────────────────────
function groundingRules(ctx: ProjectContext): string {
  return `You are a senior software architect documenting the "${ctx.name}" project (${ctx.type}).
RULES (non-negotiable):
1. Base every claim on the provided source code and structure. Do NOT invent features, endpoints, tables, or integrations absent from the code.
2. If a section cannot be substantiated from the provided context, write: "_Not found in the provided codebase._"
3. Output clean Markdown only — no preamble, no "sure, here is…", no explanations outside the document.
4. Use Mermaid fenced blocks (\`\`\`mermaid) for diagrams.`;
}

function codeBundle(ctx: ProjectContext): string {
  const parts: string[] = [];
  if (ctx.manifest) parts.push(`// MANIFEST\n${ctx.manifest.slice(0, 3000)}`);
  parts.push(`// DIRECTORY STRUCTURE\n${ctx.structure}`);
  if (ctx.existingDocs) parts.push(`// EXISTING DOCS\n${ctx.existingDocs}`);
  for (const f of ctx.sourceFiles) {
    parts.push(`// FILE: ${f.path}\n${f.content}`);
  }
  return parts.join('\n\n// ---\n\n');
}

// ── Document catalog ──────────────────────────────────────────────────────────
export const DOC_TYPES: DocType[] = [

  // ── README ──────────────────────────────────────────────────────────────────
  {
    id:         'readme',
    label:      'README',
    detail:     'Project overview, setup instructions, and quick-start guide',
    category:   'General',
    outputPath: 'README.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Write a README.md with these sections:
# Project Name
One-line description.
## Overview
What the project does and why it exists.
## Tech Stack
Languages, frameworks, key libraries.
## Prerequisites
Runtime, tools, and environment requirements.
## Getting Started
Step-by-step setup and run instructions (only those inferable from the build files).
## Project Structure
Brief description of the main folders.
## Configuration
Key configuration options and where to set them.`,
      user: `Generate the README for this project.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── ADR ─────────────────────────────────────────────────────────────────────
  {
    id:         'adr',
    label:      'Architecture Decision Records (ADR)',
    detail:     'Significant architectural decisions captured in MADR format',
    category:   'Architecture',
    outputPath: 'docs/adr.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Identify 4–6 significant architectural decisions evident in the codebase (e.g. framework choice, layering pattern, persistence strategy, auth approach).
For each, produce an ADR in MADR format:

# ADR-NNN: <title>
**Date:** YYYY-MM-DD
**Status:** Accepted

## Context
<what problem forced this decision>

## Decision
<what was decided and why>

## Consequences
<positive and negative outcomes>

---

Separate each ADR with --- and number them ADR-001, ADR-002, etc.`,
      user: `Identify and document the architectural decisions in this project.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── C4 Context ──────────────────────────────────────────────────────────────
  {
    id:         'c4-context',
    label:      'C4 — Context Diagram',
    detail:     'Level 1: the system and its external actors and dependencies',
    category:   'Architecture',
    outputPath: 'docs/c4-context.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Produce a C4 Level-1 Context diagram.
Output format:
# C4 Context: <system name>
## Description
<paragraph describing the system boundary>
## Diagram
\`\`\`mermaid
C4Context
  title Context diagram for <system name>
  Person(userAlias, "Role", "Description")
  System(sysAlias, "System Name", "Description")
  System_Ext(extAlias, "External System", "Description")
  Rel(userAlias, sysAlias, "Uses")
  Rel(sysAlias, extAlias, "Calls")
\`\`\`
## Actors and Systems
Table listing each person/system with role and responsibility.`,
      user: `Create the C4 Context diagram for this project.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── C4 Containers ───────────────────────────────────────────────────────────
  {
    id:         'c4-containers',
    label:      'C4 — Container Diagram',
    detail:     'Level 2: deployable units, databases, and their interactions',
    category:   'Architecture',
    outputPath: 'docs/c4-containers.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Produce a C4 Level-2 Container diagram showing the major deployable containers (web apps, APIs, databases, queues, etc.).
Output format:
# C4 Containers: <system name>
## Description
## Diagram
\`\`\`mermaid
C4Container
  title Container diagram for <system name>
  Person(user, "User", "Description")
  Container(app, "Application", "Technology", "Description")
  ContainerDb(db, "Database", "Technology", "Description")
  Rel(user, app, "Uses", "HTTPS")
  Rel(app, db, "Reads/Writes", "SQL")
\`\`\`
## Container Descriptions
Table: Container | Technology | Responsibility`,
      user: `Create the C4 Container diagram.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── C4 Components ───────────────────────────────────────────────────────────
  {
    id:         'c4-components',
    label:      'C4 — Component Diagram',
    detail:     'Level 3: major components within the main container',
    category:   'Architecture',
    outputPath: 'docs/c4-components.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Produce a C4 Level-3 Component diagram for the primary application container.
Show the main internal components (controllers, services, repositories, etc.) and how they interact.
Output format:
# C4 Components: <container name>
## Description
## Diagram
\`\`\`mermaid
C4Component
  title Component diagram for <container>
  Container_Boundary(app, "Application") {
    Component(ctrl, "Controller", "Technology", "Handles HTTP requests")
    Component(svc, "Service", "Technology", "Business logic")
    Component(repo, "Repository", "Technology", "Data access")
  }
  ContainerDb(db, "Database", "Technology", "Stores data")
  Rel(ctrl, svc, "Calls")
  Rel(svc, repo, "Calls")
  Rel(repo, db, "Reads/Writes")
\`\`\`
## Component Descriptions
Table: Component | Type | Responsibility | Key classes`,
      user: `Create the C4 Component diagram.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── User Stories ─────────────────────────────────────────────────────────────
  {
    id:         'user-stories',
    label:      'User Stories',
    detail:     'Feature requirements written from the user perspective with acceptance criteria',
    category:   'Requirements',
    outputPath: 'docs/user-stories.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Derive user stories from the implemented features in the codebase.
Group them by feature area (epic). For each story:

## Epic: <feature area>
### US-NNN: <short title>
**As a** <role>
**I want to** <action>
**So that** <benefit>

**Acceptance Criteria:**
- [ ] Criterion 1
- [ ] Criterion 2

Number stories US-001, US-002, etc. across all epics.
Only write stories for features clearly implemented in the code.`,
      user: `Derive user stories from the implemented features.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── Functional Spec ──────────────────────────────────────────────────────────
  {
    id:         'functional-spec',
    label:      'Functional Specification',
    detail:     'What the system does — features, business rules, workflows',
    category:   'Requirements',
    outputPath: 'docs/functional-spec.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Write a Functional Specification with these sections:
# Functional Specification: <project name>
## Purpose and Scope
## User Roles and Permissions
## Feature Catalogue
For each feature: name, description, inputs, outputs, business rules.
## Business Rules
Numbered list of rules enforced by the system.
## Key Workflows
Step-by-step descriptions of the main user flows (use numbered steps).
## Edge Cases and Validations
What the system explicitly handles.`,
      user: `Write the functional specification.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── Technical Spec ───────────────────────────────────────────────────────────
  {
    id:         'technical-spec',
    label:      'Technical Specification',
    detail:     'How the system works — architecture, patterns, data flows, tech stack',
    category:   'Technical',
    outputPath: 'docs/technical-spec.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Write a Technical Specification with these sections:
# Technical Specification: <project name>
## Technology Stack
Table: Layer | Technology | Version | Purpose
## Architecture Overview
Describe the architectural pattern (MVC, Clean, Hexagonal, layered, etc.) with evidence from the code.
## Module and Package Structure
Describe each major package/namespace and its responsibility.
## Data Flow
Describe how a typical request flows through the system (e.g. HTTP → Controller → Service → Repository → DB).
## Key Design Patterns
Patterns identified in the code with examples.
## External Integrations
APIs, queues, and third-party services.
## Security Considerations
Auth, authorization, input validation, data protection.
## Non-Functional Characteristics
Performance notes, scalability considerations, known limitations.`,
      user: `Write the technical specification.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── API Reference ────────────────────────────────────────────────────────────
  {
    id:         'api-reference',
    label:      'API Reference',
    detail:     'All endpoints with methods, paths, parameters, and response shapes',
    category:   'Technical',
    outputPath: 'docs/api-reference.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Document every HTTP endpoint, RPC method, or public interface found in the codebase.
For each endpoint/method:

### <METHOD> <path>  (or  ### ClassName.methodName)
**Description:** what it does
**Auth required:** yes/no
**Request parameters:**
| Name | Location | Type | Required | Description |
|------|----------|------|----------|-------------|

**Request body:** (if applicable)
\`\`\`json
{ "field": "type" }
\`\`\`
**Response:**
\`\`\`json
{ "field": "type" }
\`\`\`
**Error codes:** list with meaning

Group by controller/resource. Only document endpoints present in the code.`,
      user: `Document all API endpoints and public interfaces.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── Data Model ───────────────────────────────────────────────────────────────
  {
    id:         'data-model',
    label:      'Data Model',
    detail:     'Entities, tables, fields, relationships, and ER diagram',
    category:   'Technical',
    outputPath: 'docs/data-model.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Document the data model with:
# Data Model: <project name>
## Entity-Relationship Diagram
\`\`\`mermaid
erDiagram
  ENTITY1 {
    type fieldName PK
    type fieldName
  }
  ENTITY2 {
    type fieldName PK
    type foreignKey FK
  }
  ENTITY1 ||--o{ ENTITY2 : "has"
\`\`\`
## Entity Descriptions
For each entity/table:
### <EntityName>
**Table/Collection:** <name>
| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
**Relationships:** described in prose.

Only document entities found in the code (models, entities, DTOs, schema definitions).`,
      user: `Document the data model.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── Deployment Guide ─────────────────────────────────────────────────────────
  {
    id:         'deployment',
    label:      'Deployment Guide',
    detail:     'Build, package, environment variables, and deployment steps',
    category:   'Technical',
    outputPath: 'docs/deployment.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Write a Deployment Guide with:
# Deployment Guide: <project name>
## Environment Requirements
OS, runtime versions, required tools.
## Environment Variables and Configuration
Table: Variable | Default | Required | Description
(only variables referenced in the code or config files)
## Build
Step-by-step build commands (from the manifest/build files).
## Run
How to start the application locally.
## Production Deployment
Packaging and deployment steps inferable from the build configuration.
## Health Checks
Any health/readiness endpoints found in the code.
## Troubleshooting
Common startup errors and fixes (only those inferable from error handling in code).`,
      user: `Write the deployment guide.\n\n${codeBundle(ctx)}`,
    }),
  },

  // ── Glossary ─────────────────────────────────────────────────────────────────
  {
    id:         'glossary',
    label:      'Glossary',
    detail:     'Domain terms, acronyms, and system-specific concepts',
    category:   'General',
    outputPath: 'docs/glossary.md',
    prompt: ctx => ({
      system: `${groundingRules(ctx)}
Extract domain terms, acronyms, and system-specific concepts from the codebase (class names, method names, configuration keys, business rules).
Format:
# Glossary: <project name>
| Term | Definition |
|------|------------|
| Term | What it means in this system |

Sort alphabetically. Only include terms present in the code or documentation.`,
      user: `Extract and define the domain glossary.\n\n${codeBundle(ctx)}`,
    }),
  },

];

// Convenience map for lookup by id
export const DOC_TYPE_MAP = new Map(DOC_TYPES.map(d => [d.id, d]));
