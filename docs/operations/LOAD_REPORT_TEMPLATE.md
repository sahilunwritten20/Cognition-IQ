# Load test report

Date: ____  Run by: ____  Staging build (git tag): ____  Reviewed by: ____

## Configuration
| Item | Value |
|---|---|
| API instances (count x size) | |
| MongoDB tier / region / version | |
| Redis | |
| Worker process (sweeper + imports) | |
| `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` | |
| `MONGODB_MAX_POOL_SIZE` / `UV_THREADPOOL_SIZE` | |
| Load generator (machine, region) | |
| k6 command line | |

## Results (p50 / p95 / p99, ms)
| Scenario | Users | login | start | autosave | submit | monitor | results | error rate | verify |
|---|---|---|---|---|---|---|---|---|---|
| A login storm | | | | | | | | | n/a |
| B mass start (10 s) | | | | | | | | | |
| B mass start (60 s) | | | | | | | | | |
| C steady autosave | | | | | | | | | |
| D mass submit + abandon 10% | | | | | | | | | |
| E monitor + results | | | | | | | | | |
| F imports wait during exam | | n/a | | | | | | | n/a |

## Resources at peak
API CPU / memory: ____  MongoDB CPU / connections / ops per second: ____  Slow queries: ____  5xx / 429 count: ____

## Fault injection
| Fault | Outcome | verify |
|---|---|---|
| Kill one API instance | | |
| Rolling restart | | |
| Worker stopped | | |
| Redis stopped | | |
| Mongo step-down | | |

## Verdict against the targets
- [ ] p95 < 500 ms at ____ users   - [ ] error rate < 0.1%   - [ ] verify PASS in every scenario   - [ ] results visible < 10 s   - [ ] sweeper < 1 min
Measured capacity: ____ concurrent exam takers. Revised target needed? yes / no. Approved by (product owner): ____ Date: ____
