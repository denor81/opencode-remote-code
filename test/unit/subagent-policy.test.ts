import { describe, expect, it } from "vitest"
import { applySubagentPolicy } from "../../src/subagent-policy.js"

describe("resolved subagent policy", () => {
  it("installs the launch defaults into an empty resolved config", () => {
    const config: Record<string, unknown> = {}

    const policy = applySubagentPolicy(config)

    expect(config).toEqual({
      subagent_depth: 1,
      permission: { remote_status: "ask" },
      experimental: { primary_tools: ["task"] },
    })
    expect(policy).toEqual({
      requestedDepth: null,
      effectiveDepth: 1,
      depthWasNarrowed: false,
      taskPrimaryOnly: true,
    })
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it.each(["allow", "ask", "deny"] as const)(
    "preserves a global %s action-string policy",
    (action) => {
      const config: Record<string, unknown> = { permission: action }

      applySubagentPolicy(config)

      expect(config.permission).toBe(action)
    }
  )

  it.each(["allow", "ask", "deny"] as const)(
    "preserves an exact remote_status %s rule",
    (action) => {
      const permission = { bash: "allow", remote_status: action }
      const config: Record<string, unknown> = { permission }

      applySubagentPolicy(config)

      expect(config.permission).toBe(permission)
      expect(permission).toEqual({ bash: "allow", remote_status: action })
    }
  )

  it.each(["*", "remote_*", "remote?status"])(
    "recognizes the global wildcard rule %s as explicit",
    (pattern) => {
      const permission = { bash: "allow", [pattern]: "deny" }
      const config: Record<string, unknown> = { permission }

      applySubagentPolicy(config)

      expect(config.permission).toBe(permission)
      expect(Object.keys(permission)).toEqual(["bash", pattern])
      expect(permission).not.toHaveProperty("remote_status")
    }
  )

  it.each(["allow", "ask", "deny"] as const)(
    "preserves an explore %s action-string policy",
    (action) => {
      const explore = { permission: action }
      const config: Record<string, unknown> = { agent: { explore } }

      applySubagentPolicy(config)

      expect(config).not.toHaveProperty("permission")
      expect(explore.permission).toBe(action)
    }
  )

  it.each(["*", "remote_*", "remote?status"])(
    "recognizes the explore wildcard rule %s as explicit",
    (pattern) => {
      const explore = {
        description: "Keep this configured explore agent",
        permission: { read: "allow", [pattern]: "ask" },
      }
      const config: Record<string, unknown> = { agent: { explore } }

      applySubagentPolicy(config)

      expect(config).not.toHaveProperty("permission")
      expect((config.agent as { explore: unknown }).explore).toBe(explore)
      expect(explore.permission).toEqual({ read: "allow", [pattern]: "ask" })
    }
  )

  it("preserves permission rule order in both last-match directions", () => {
    const exactThenWildcard = {
      remote_status: "deny",
      "*": "allow",
    }
    const wildcardThenExact = {
      "*": "allow",
      remote_status: "deny",
    }
    const first: Record<string, unknown> = { permission: exactThenWildcard }
    const second: Record<string, unknown> = { permission: wildcardThenExact }

    applySubagentPolicy(first)
    applySubagentPolicy(second)

    expect(Object.entries(exactThenWildcard)).toEqual([
      ["remote_status", "deny"],
      ["*", "allow"],
    ])
    expect(Object.entries(wildcardThenExact)).toEqual([
      ["*", "allow"],
      ["remote_status", "deny"],
    ])
  })

  it("preserves a disabled explore agent while installing the global default", () => {
    const explore = {
      disable: true,
      description: "Disabled by the user",
    }
    const config: Record<string, unknown> = { agent: { explore } }

    applySubagentPolicy(config)

    expect(config.permission).toEqual({ remote_status: "ask" })
    expect((config.agent as { explore: unknown }).explore).toBe(explore)
    expect(explore).toEqual({
      disable: true,
      description: "Disabled by the user",
    })
  })

  it("preserves explicit policy on a disabled explore agent", () => {
    const explore = {
      disable: true,
      permission: { "*": "deny" },
    }
    const config: Record<string, unknown> = { agent: { explore } }

    applySubagentPolicy(config)

    expect(config).not.toHaveProperty("permission")
    expect((config.agent as { explore: unknown }).explore).toBe(explore)
  })

  it("preserves unrelated agents, permission rules, and experimental fields", () => {
    const reviewer = {
      mode: "subagent",
      permission: { "*": "deny" },
      options: { careful: true },
    }
    const policies = [{ resource: "provider", action: "deny" }]
    const config: Record<string, unknown> = {
      permission: { bash: "ask" },
      agent: { reviewer },
      experimental: {
        batch_tool: true,
        policies,
        primary_tools: ["bash", "task", "read", "task"],
      },
      model: "fixture/model",
    }

    applySubagentPolicy(config)

    expect(config).toMatchObject({
      permission: { bash: "ask", remote_status: "ask" },
      agent: { reviewer },
      experimental: {
        batch_tool: true,
        policies,
        primary_tools: ["bash", "task", "read"],
      },
      model: "fixture/model",
    })
    expect((config.agent as { reviewer: unknown }).reviewer).toBe(reviewer)
    expect(
      (config.experimental as { policies: unknown }).policies
    ).toBe(policies)
  })

  it.each([
    {
      name: "absent",
      input: undefined,
      requestedDepth: null,
      effectiveDepth: 1,
      depthWasNarrowed: false,
    },
    {
      name: "zero",
      input: 0,
      requestedDepth: 0,
      effectiveDepth: 0,
      depthWasNarrowed: false,
    },
    {
      name: "one",
      input: 1,
      requestedDepth: 1,
      effectiveDepth: 1,
      depthWasNarrowed: false,
    },
    {
      name: "greater than one",
      input: 4,
      requestedDepth: 4,
      effectiveDepth: 1,
      depthWasNarrowed: true,
    },
  ])(
    "normalizes $name depth to $effectiveDepth",
    ({ input, requestedDepth, effectiveDepth, depthWasNarrowed }) => {
      const config: Record<string, unknown> = {}
      if (input !== undefined) config.subagent_depth = input

      const policy = applySubagentPolicy(config)

      expect(config.subagent_depth).toBe(effectiveDepth)
      expect(policy).toEqual({
        requestedDepth,
        effectiveDepth,
        depthWasNarrowed,
        taskPrimaryOnly: true,
      })
    }
  )

  it("is idempotent and does not duplicate task or the status default", () => {
    const config: Record<string, unknown> = {
      subagent_depth: 1,
      permission: { bash: "allow" },
      experimental: { primary_tools: ["bash"] },
    }

    applySubagentPolicy(config)
    const afterFirstApplication = structuredClone(config)
    applySubagentPolicy(config)

    expect(config).toEqual(afterFirstApplication)
    expect(config).toEqual({
      subagent_depth: 1,
      permission: { bash: "allow", remote_status: "ask" },
      experimental: { primary_tools: ["bash", "task"] },
    })
  })

  it.each([
    { name: "null root", value: null },
    { name: "array root", value: [] },
    { name: "negative depth", value: { subagent_depth: -1 } },
    { name: "fractional depth", value: { subagent_depth: 1.5 } },
    { name: "string depth", value: { subagent_depth: "1" } },
    { name: "null permission", value: { permission: null } },
    { name: "array permission", value: { permission: [] } },
    {
      name: "unknown permission action",
      value: { permission: { remote_status: "sometimes" } },
    },
    {
      name: "unknown patterned action",
      value: { permission: { remote_status: { "*": "sometimes" } } },
    },
    { name: "array agent map", value: { agent: [] } },
    { name: "non-object explore agent", value: { agent: { explore: false } } },
    {
      name: "non-boolean explore disable",
      value: { agent: { explore: { disable: "yes" } } },
    },
    {
      name: "malformed explore permission",
      value: { agent: { explore: { permission: 5 } } },
    },
    { name: "array experimental config", value: { experimental: [] } },
    {
      name: "non-array primary tools",
      value: { experimental: { primary_tools: "task" } },
    },
    {
      name: "non-string primary tool",
      value: { experimental: { primary_tools: ["bash", 1] } },
    },
  ])("rejects incompatible $name", ({ value }) => {
    expect(() => applySubagentPolicy(value)).toThrow(
      /incompatible resolved OpenCode config/i
    )
  })

  it("validates the complete relevant shape before mutating", () => {
    const config = {
      subagent_depth: 8,
      permission: { bash: "allow" },
      experimental: { primary_tools: ["bash", 1] },
    }
    const original = structuredClone(config)

    expect(() => applySubagentPolicy(config)).toThrow(
      /incompatible resolved OpenCode config/i
    )
    expect(config).toEqual(original)
  })

  it("rejects an enabled mcp.remote namespace collision before mutating", () => {
    const config = {
      subagent_depth: 7,
      permission: { bash: "allow" },
      mcp: {
        remote: {
          type: "remote",
          url: "https://mcp.invalid",
          enabled: true,
        },
      },
    }
    const original = structuredClone(config)

    expect(() => applySubagentPolicy(config)).toThrow(
      /enabled mcp\.remote.*remote_status/i
    )
    expect(config).toEqual(original)
  })

  it("allows a disabled mcp.remote and unrelated enabled MCP servers", () => {
    const config = {
      mcp: {
        remote: {
          type: "remote",
          url: "https://disabled.invalid",
          enabled: false,
        },
        search: {
          type: "remote",
          url: "https://search.invalid",
          enabled: true,
        },
      },
    }

    expect(() => applySubagentPolicy(config)).not.toThrow()
    expect(config.mcp.search.enabled).toBe(true)
  })
})
