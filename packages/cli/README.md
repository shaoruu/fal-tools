# fal-tools

CLI composition for the fal-tools packages.

```sh
fal-tools plan manifest.yaml
fal-tools run manifest.yaml --out ./workdir/run-001 --max-calls 8
fal-tools audit ./workdir/run-001/run.json
fal-tools export selection.yaml --from ./workdir/run-001 --to ./release
```
