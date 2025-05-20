# coinflip

## Dev

Install bun:

```
curl -fsSL https://bun.sh/install | bash
```

Install deps:

```
bun install
```

Generate db:

```
bunx prisma migrate dev
bunx prisma generate
```

Start:

```
bun start
```

## Prod

```
sudo docker compose up -d
```
