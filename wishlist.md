- Be able to run khala-cli as npx github:pesap/khala. Add #!/usr/bin/env node to
  the code
- FIx/clean all the node installationL

```console
khala on  main via  v25.2.1 via 37GiB/48GiB | 1GiB/2GiB took 4s
❯ pi install  https://github.com/pesap/khala
Installing https://github.com/pesap/khala...
Cloning into '/Users/psanchez/.pi/agent/git/github.com/pesap/khala'...
remote: Enumerating objects: 4659, done.
remote: Counting objects: 100% (722/722), done.
remote: Compressing objects: 100% (216/216), done.
remote: Total 4659 (delta 617), reused 513 (delta 505), pack-reused 3937 (from 1)
Receiving objects: 100% (4659/4659), 3.46 MiB | 8.75 MiB/s, done.
Resolving deltas: 100% (2563/2563), done.
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

added 252 packages, and audited 253 packages in 4s
```

- Fix preflight UX for agent when running enforce:

```
 $ /preflight Preflight: skill=github reason="Investigate failing CI/CD using gh read-only commands"
 clarify=no (timeout 10s)

 /bin/bash: line 1: /preflight: No such file or directory


 Command exited with code 127
```

- Add MIT license
- Clean README with new commands. It still uses : khala status instead of
  khala-status
- Uodate core loop diagram looks like a constant flow not a loop
- Use same color pallete for khala-mode banner on pi. khala mode should
  behiglight at different color dependdning on the mode but kahala mode should
  follow similar pi colors.
