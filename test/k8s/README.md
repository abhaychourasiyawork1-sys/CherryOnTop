# Kubernetes tests

Kubernetes tests require a clean reachable Kind cluster and are run only by
`npm run test:k8s` in the dedicated CI job. Pure manifest and client-shaping
tests stay in the unit suite; live Jobs, Pods, logs, and cluster wiring belong
here.
