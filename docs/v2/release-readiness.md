# v2 alpha release readiness

The package remains `2.0.0-alpha.1`. This branch is a development line and is
not a publication, tag, GitHub release, or promotion to `latest`.

Readiness is computed from `docs/v2/milestone-completion.json` with:

```bash
npm run verify:v2-milestones
npm run benchmark:v2
npm run verify:benchmark:v2
```

The benchmark report includes B1–B14 candidate results and a same-revision
serial reference. The historical `0ac894959587e5a2dfc11a66766fc834a64d5226`
revision predates the v2 surface, so no historical performance delta is
claimed without an equivalent runnable control.
