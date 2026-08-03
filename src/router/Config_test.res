// ---------------------------------------------------------------------------
// Config_test.res — RED-first parity tests for Config.parse
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let stringEqual = (~message: option<string>=?, a: string, b: string) =>
  assertion(~message?, ~operator="stringEqual", (a, b) => a === b, a, b)

let intEqual = (~message: option<string>=?, a: int, b: int) =>
  assertion(~message?, ~operator="intEqual", (a, b) => a === b, a, b)

let floatEqual = (~message: option<string>=?, a: float, b: float) =>
  assertion(~message?, ~operator="floatEqual", (a, b) => a === b, a, b)

let assertEqual = (a: 'a, b: 'a): unit => assertion((x, y) => x === y, a, b)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let json = (s: string): JSON.t => JSON.parseOrThrow(s)

// ---------------------------------------------------------------------------
// Root required fields
// ---------------------------------------------------------------------------

test("Config.parse: valid minimal config returns Some", () => {
  let input = `{
    "activePreset": "multi-provider",
    "presets": {
      "test": {
        "fast": {
          "model": "test/model",
          "description": "test",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) => {
      stringEqual(config.activePreset, "multi-provider")
      stringEqual(config.defaultTier, "fast")
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: missing activePreset returns None", () => {
  let result = Config.parse(json(`{"presets": {},"rules":[],"defaultTier":"fast"}`))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: missing presets returns None", () => {
  let result = Config.parse(json(`{"activePreset":"test","rules":[],"defaultTier":"fast"}`))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: missing rules returns None", () => {
  let result = Config.parse(json(`{"activePreset":"test","presets":{},"defaultTier":"fast"}`))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: missing defaultTier returns None", () => {
  let result = Config.parse(json(`{"activePreset":"test","presets":{},"rules":[]}`))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: activePreset not string returns None", () => {
  let result = Config.parse(
    json(`{"activePreset":123,"presets":{},"rules":[],"defaultTier":"fast"}`),
  )
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: empty presets object returns None", () => {
  let result = Config.parse(
    json(`{"activePreset":"test","presets":{},"rules":[],"defaultTier":"fast"}`),
  )
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

// ---------------------------------------------------------------------------
// TierConfig nested fields
// ---------------------------------------------------------------------------

test("Config.parse: tier missing model returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: tier missing description returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: tier missing whenToUse returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier"
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: tier with optional variant and costRatio parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "variant": "high",
          "costRatio": 3,
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch Dict.get(config.presets, "test") {
    | Some(preset) =>
      switch Dict.get(preset, "fast") {
      | Some(tier) => {
          switch tier.variant {
          | Some(v) => stringEqual(v, "high")
          | None => assertion((_, _) => false, true, false)
          }
          switch tier.costRatio {
          | Some(r) => floatEqual(r, 3.0)
          | None => assertion((_, _) => false, true, false)
          }
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: model without slash returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "invalidmodel",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

// ---------------------------------------------------------------------------
// Tier reasoning blocks
// ---------------------------------------------------------------------------

test("Config.parse: tier with reasoning.effort parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "heavy": {
          "model": "provider/model",
          "description": "a tier",
          "reasoning": {
            "effort": "high",
            "summary": "detailed"
          },
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "heavy"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch Dict.get(config.presets, "test") {
    | Some(preset) =>
      switch Dict.get(preset, "heavy") {
      | Some(tier) =>
        switch tier.reasoning {
        | Some(reas) =>
          switch reas.effort {
          | Some(e) => stringEqual(e, "high")
          | None => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: tier with thinking.budgetTokens parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "anthropic/model",
          "thinking": {
            "budgetTokens": 1024
          },
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch Dict.get(config.presets, "test") {
    | Some(preset) =>
      switch Dict.get(preset, "fast") {
      | Some(tier) =>
        switch tier.thinking {
        | Some(th) =>
          switch th.budgetTokens {
          | Some(bt) => intEqual(bt, 1024)
          | None => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

test("Config.parse: modes.overrideRules parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "modes": {
      "budget": {
        "defaultTier": "fast",
        "description": "Budget mode",
        "overrideRules": ["default->fast"]
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.modes->Belt.Option.flatMap(modesDict => Dict.get(modesDict, "budget")) {
    | Some(mode) => {
        stringEqual(mode.defaultTier, "fast")
        switch mode.overrideRules {
        | Some(rules) => intEqual(Array.length(rules), 1)
        | None => assertion((_, _) => false, true, false)
        }
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

// ---------------------------------------------------------------------------
// Enforcement config
// ---------------------------------------------------------------------------

test("Config.parse: enforcement mode enforced parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "enforcement": {
      "mode": "enforced"
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.enforcement {
    | Some(enf) =>
      switch enf.mode {
      | Some(#enforced) => pass()
      | _ => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: enforcement mode invalid returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "enforcement": {
      "mode": "invalid-mode"
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: enforcement perTier parsing", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "enforcement": {
      "perTier": {
        "fast": "off"
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.enforcement {
    | Some(enf) =>
      switch enf.perTier {
      | Some(pt) =>
        switch Dict.get(pt, "fast") {
        | Some("off") => pass()
        | _ => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: enforcement guard block parsing", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "enforcement": {
      "guard": {
        "blockSelfScript": true,
        "budget": 5000
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.enforcement {
    | Some(enf) =>
      switch enf.guard {
      | Some(guard) => switch guard.blockSelfScript {
        | Some(true) => pass()
        | Some(false) => assertion((_, _) => false, true, false)
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: enforcement verify block parsing", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "enforcement": {
      "verify": {
        "require": "always",
        "graderPolicy": "atLeastProducerTier",
        "skipFastTier": false
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.enforcement {
    | Some(enf) =>
      switch enf.verify {
      | Some(verify) => switch verify.require {
        | Some("always") => pass()
        | _ => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: enforcement escalate.floorTier null parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "enforcement": {
      "escalate": {
        "floorTier": null
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.enforcement {
    | Some(enf) =>
      switch enf.escalate {
      | Some(esc) =>
        switch esc.floorTier {
        | Some(_) => assertion((_, _) => false, true, false)
        | None => pass()
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: enforcement escalate.costCeiling parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "enforcement": {
      "escalate": {
        "costCeiling": {
          "base": "medium",
          "multiple": 3.0
        }
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.enforcement {
    | Some(enf) =>
      switch enf.escalate {
      | Some(esc) =>
        switch esc.costCeiling {
        | Some(cc) => {
            switch cc.base {
            | Some(b) => stringEqual(b, "medium")
            | None => assertion((_, _) => false, true, false)
            }
            switch cc.multiple {
            | Some(m) => floatEqual(m, 3.0)
            | None => assertion((_, _) => false, true, false)
            }
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

// ---------------------------------------------------------------------------
// Reasoning policy
// ---------------------------------------------------------------------------

test("Config.parse: reasoningPolicy.trivialLevel null is valid", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "mode": "adaptive",
      "adaptive": {
        "trivialLevel": null,
        "defaultLevel": "normal"
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.reasoningPolicy {
    | Some(rp) =>
      switch rp.adaptive {
      | Some(adapt) =>
        switch adapt.trivialLevel {
        | None => pass()
        | Some(_) => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: reasoningPolicy.keywordRules parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "adaptive": {
        "keywordRules": [
          {
            "keywords": ["format", "lint"],
            "level": "minimal"
          },
          {
            "keywords": ["debug", "security"],
            "level": "elevated",
            "match": "substring"
          }
        ]
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.reasoningPolicy {
    | Some(rp) =>
      switch rp.adaptive {
      | Some(adapt) =>
        switch adapt.keywordRules {
        | Some(rules) => intEqual(Array.length(rules), 2)
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: reasoningPolicy.keywordRules level = minimal returns Some", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "adaptive": {
        "keywordRules": [
          {
            "keywords": ["format", "lint"],
            "level": "minimal"
          }
        ]
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.reasoningPolicy {
    | Some(rp) =>
      switch rp.adaptive {
      | Some(adapt) =>
        switch adapt.keywordRules {
        | Some(rules) =>
          switch Array.length(rules) == 1 {
          | true =>
            switch rules[0] {
            | Some(kr) =>
              switch kr.level {
              | "minimal" => pass()
              | _ => assertion((_, _) => false, true, false)
              }
            | None => assertion((_, _) => false, true, false)
            }
          | false => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: reasoningPolicy.keywordRules level = max returns Some", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "adaptive": {
        "keywordRules": [
          {
            "keywords": ["security"],
            "level": "max"
          }
        ]
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.reasoningPolicy {
    | Some(rp) =>
      switch rp.adaptive {
      | Some(adapt) =>
        switch adapt.keywordRules {
        | Some(rules) =>
          switch Array.length(rules) == 1 {
          | true =>
            switch rules[0] {
            | Some(kr) =>
              switch kr.level {
              | "max" => pass()
              | _ => assertion((_, _) => false, true, false)
              }
            | None => assertion((_, _) => false, true, false)
            }
          | false => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: reasoningPolicy.adaptive.tierDefaults fast = elevated returns Some", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "adaptive": {
        "defaultLevel": "normal",
        "tierDefaults": {
          "fast": "elevated"
        }
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch config.reasoningPolicy {
    | Some(rp) =>
      switch rp.adaptive {
      | Some(adapt) =>
        switch adapt.tierDefaults {
        | Some(td) =>
          switch Dict.get(td, "fast") {
          | Some("elevated") => pass()
          | _ => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: reasoningPolicy.keywordRules level invalid returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "adaptive": {
        "keywordRules": [
          {
            "keywords": ["test"],
            "level": "invalid-level"
          }
        ]
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: reasoningPolicy.keywordRules empty keywords returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "adaptive": {
        "keywordRules": [
          {
            "keywords": [],
            "level": "minimal"
          }
        ]
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

test("Config.parse: reasoningPolicy.keywordRules regex compile-fail returns None", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"]
        }
      }
    },
    "rules": [],
    "defaultTier": "fast",
    "reasoningPolicy": {
      "adaptive": {
        "keywordRules": [
          {
            "keywords": ["[invalid"],
            "level": "minimal",
            "match": "regex"
          }
        ]
      }
    }
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(_) => assertion((_, _) => false, true, false)
  | None => pass()
  }
})

// ---------------------------------------------------------------------------
// Tier capability
// ---------------------------------------------------------------------------

test("Config.parse: tier capability kind none parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "fast": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"],
          "capability": {
            "kind": "none"
          }
        }
      }
    },
    "rules": [],
    "defaultTier": "fast"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch Dict.get(config.presets, "test") {
    | Some(preset) =>
      switch Dict.get(preset, "fast") {
      | Some(tier) =>
        switch tier.capability {
        | Some(cap) =>
          switch cap {
          | TC_None => pass()
          | _ => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: tier capability kind binary parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "medium": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"],
          "capability": {
            "kind": "binary",
            "field": "variant",
            "elevated": "max"
          }
        }
      }
    },
    "rules": [],
    "defaultTier": "medium"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch Dict.get(config.presets, "test") {
    | Some(preset) =>
      switch Dict.get(preset, "medium") {
      | Some(tier) =>
        switch tier.capability {
        | Some(cap) =>
          switch cap {
          | Binary({field: "variant", elevated: ev}) => stringEqual(ev, "max")
          | _ => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: tier capability kind discrete parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "light": {
          "model": "provider/model",
          "description": "a tier",
          "whenToUse": ["test"],
          "capability": {
            "kind": "discrete",
            "field": "variant",
            "levels": ["low", "medium", "high"]
          }
        }
      }
    },
    "rules": [],
    "defaultTier": "light"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch Dict.get(config.presets, "test") {
    | Some(preset) =>
      switch Dict.get(preset, "light") {
      | Some(tier) =>
        switch tier.capability {
        | Some(cap) =>
          switch cap {
          | Discrete({levels: lv}) => intEqual(Array.length(lv), 3)
          | _ => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

test("Config.parse: tier capability kind budgeted parses", () => {
  let input = `{
    "activePreset": "test",
    "presets": {
      "test": {
        "heavy": {
          "model": "anthropic/model",
          "description": "a tier",
          "whenToUse": ["test"],
          "capability": {
            "kind": "budgeted",
            "field": "thinking.budgetTokens",
            "recommended": {
              "minimal": 1024,
              "normal": 4096,
              "elevated": 8192,
              "max": 16384
            }
          }
        }
      }
    },
    "rules": [],
    "defaultTier": "heavy"
  }`
  let result = Config.parse(json(input))
  switch result {
  | Some(config) =>
    switch Dict.get(config.presets, "test") {
    | Some(preset) =>
      switch Dict.get(preset, "heavy") {
      | Some(tier) =>
        switch tier.capability {
        | Some(cap) =>
          switch cap {
          | Budgeted({recommended: recMap}) =>
            switch Dict.get(recMap, "normal") {
            | Some(v) => intEqual(Float.toInt(v), 4096)
            | None => assertion((_, _) => false, true, false)
            }
          | _ => assertion((_, _) => false, true, false)
          }
        | None => assertion((_, _) => false, true, false)
        }
      | None => assertion((_, _) => false, true, false)
      }
    | None => assertion((_, _) => false, true, false)
    }
  | None => assertion((_, _) => false, true, false)
  }
})

// ---------------------------------------------------------------------------
// Bundled tiers.json round-trip
// ---------------------------------------------------------------------------

// Skip: requires Node.Fs which is not available in this environment
// test("Config.parse: bundled tiers.json parses successfully", () => {
//   let content = Node.Fs.readFileSync("tiers.json", #utf8)
//   let parsed = Js.Json.parseExn(content)
//   let result = Config.parse(parsed)
//   switch result {
//   | Some(config) => {
//     stringEqual(config.activePreset, "multi-provider")
//     stringEqual(config.defaultTier, "medium")
//   }
//   | None => assertion((_, _) => false, true, false)
//   }
// })
