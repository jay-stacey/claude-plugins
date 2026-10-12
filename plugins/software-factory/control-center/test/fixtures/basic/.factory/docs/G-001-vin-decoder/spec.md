# Spec: VIN decoder

## API

`GET /api/vin/decode?vin=` returns `{year, make, model, trim}`.

```ts
export interface VinDecode { year: number; make: string }
```

## Data

Table `vin_decodes (vin pk, payload jsonb, decoded_at)`.
