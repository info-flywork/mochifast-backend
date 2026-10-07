# İzleme

| Kaynak                 | Ne                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API `:9464/metrics`    | `http_request_duration_seconds` (method, route, status), `cache_requests_total`, `db_pool_connections`, Node varsayılanları                                                             |
| Worker `:9465/metrics` | `jobs_runs_total` / `jobs_duration_seconds` (kuyruk, iş, sonuç), `jobs_count`, `jobs_oldest_pending_seconds`, `ai_cost_today_usd`, `push_deliveries_last_hour`, `notifications_overdue` |
| Sentry                 | Hatalar; izleme (tracing) `SENTRY_TRACES_SAMPLE_RATE` ile (ör. 0.05)                                                                                                                    |
| Uptime                 | Dışarıdan `GET /health/ready` (1 dk) — UptimeRobot / Better Stack                                                                                                                       |

Portlar dışarıya **açılmaz** (yalnızca 127.0.0.1 ya da iç ağ). Prometheus aynı sunucuda ya da
Grafana Cloud Agent ile toplanır; `alerts.yml` kuralları yüklenir.

```yaml
# prometheus.yml (örnek)
scrape_configs:
  - job_name: mochifast-api
    static_configs: [{ targets: ['127.0.0.1:9464'] }]
  - job_name: mochifast-worker
    static_configs: [{ targets: ['127.0.0.1:9465'] }]
rule_files: [alerts.yml]
```

**Dashboard panelleri (PromQL):**

- İstek hızı: `sum by (route) (rate(http_request_duration_seconds_count[5m]))`
- p95: `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))`
- 5xx oranı: `sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[5m])) / sum(rate(http_request_duration_seconds_count[5m]))`
- Cache isabet: `sum(rate(cache_requests_total{result="hit"}[5m])) / sum(rate(cache_requests_total[5m]))`
- DB havuzu: `db_pool_connections`
- Kuyruklar: `jobs_count`, `jobs_oldest_pending_seconds`, `sum by (queue, outcome) (rate(jobs_runs_total[15m]))`
- AI: `ai_cost_today_usd`; push: `push_deliveries_last_hour`
