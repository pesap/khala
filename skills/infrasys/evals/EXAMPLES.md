# infrasys Skill Trigger Examples

Use these prompts to validate when this skill should activate.

## Should trigger — train set

1. "Inspect this infrasys `System`, list generators and buses, and show me what
   time series are attached."
2. "Add a new component type, attach it to the system, and verify
   `to_json`/`from_json` round-trip integrity."
3. "Convert the time series storage from Arrow to HDF5 and check nothing is
   lost."
4. "Model a piecewise heat rate curve for a thermal generator and attach it as a
   FuelCurve."
5. "Why does `from_json` fail with a missing type error? Help me debug the
   deserialization."
6. "Attach supplemental attributes to multiple buses and verify the many-to-many
   associations round-trip through serialization."

## Should trigger — validation set

7. "What components does this system have?"
8. "I changed `gen.bus` references after loading, now parent lookups seem wrong.
   Diagnose and fix the association state."
9. "Add weather data to the model as time series."
10. "Implement a custom `System` upgrade path using `data_format_version` and
    `handle_data_format_upgrade`."

## Implicit-intent triggers (should also trigger)

1. "What's in this system?" (implies system inspection)
2. "Add weather data to the model" (implies time series attach)
3. "The old snapshot won't load anymore" (implies serialization/migration
   debugging)
4. "I need to tag geographic info on several generators" (implies supplemental
   attributes)
5. "How do I represent a non-linear cost function?" (implies cost curves)
6. "Build a grid model with generators and buses" (domain synonym: grid model =
   System)
7. "My power system model needs fuel accounting" (domain synonym + fuel =
   FuelCurve)
8. "How do I share metadata across multiple components?" (generic phrasing for
   supplemental attributes)

## Near-miss negatives — train set

1. "My task is generic architecture brainstorming, not tied to infrasys APIs."
2. "Help me choose between unrelated web frameworks for a UI app."
3. "Design the r2x-core plugin registration lifecycle." (r2x-core skill, not
   infrasys)
4. "Write a REST API endpoint for user authentication."
5. "How should I structure my Django models?" (wrong ORM, not infrasys)
6. "Optimize a SQL query for a Postgres database." (not infrasys metadata)

## Near-miss negatives — validation set

7. "Build a React dashboard for visualizing grid data." (UI, not modeling layer)
8. "Configure CI/CD pipeline for the repo." (DevOps, not infrasys)
9. "Review the r2x-core datastore ingestion rules." (r2x-core skill)
10. "Summarize a product roadmap with no system-modeling context."

## Borderline prompts (trigger + load specific reference)

1. "Fix deserialization of old snapshots and migrate schema safely." → Trigger
   this skill, then load `references/SERIALIZATION_MIGRATION.md`.
2. "Model production variable costs and convert incremental to input-output
   forms." → Trigger this skill, then load `references/COST_CURVES.md`.
3. "Attach scenario-tagged time series to generators with HDF5 backend." →
   Trigger this skill, then load `references/TIME_SERIES.md`.
4. "Add geographic metadata shared across buses and generators." → Trigger this
   skill, then load `references/SUPPLEMENTAL_ATTRIBUTES.md`.
