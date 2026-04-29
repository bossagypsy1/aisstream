import { setupSchema, upsertMpas } from "../src/db";

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id?: string;
    geometry: {
      type: string;
      coordinates: unknown;
    };
    properties: Record<string, unknown>;
  }>;
};

const SOURCE_NAME = "Natural England";
const SOURCE_DATASET = "Marine Conservation Zones (England)";
const SOURCE_URL =
  "https://environment.data.gov.uk/geoservices/datasets/c0061c93-d444-481c-a14e-653b8a8e2b1a/ogc/features/v1/collections/Marine_Conservation_Zones_England/items?f=application/geo%2Bjson&limit=200";

function designationTypeFor(feature: GeoJsonFeatureCollection["features"][number]): string {
  const props = feature.properties;
  const code = String(props.mcz_code ?? "");
  const name = String(props.mcz_name ?? "");

  if (/HPMA/i.test(code) || /HPMA/i.test(name)) return "HPMA";
  if (/SAC/i.test(code) || /SPA/i.test(code)) return "SAC/SPA";
  return "MCZ";
}

function buildMetadata(feature: GeoJsonFeatureCollection["features"][number]): Record<string, unknown> {
  const props = feature.properties;
  return {
    source_dataset: SOURCE_DATASET,
    source_url: SOURCE_URL,
    source_feature_id: feature.id ?? null,
    mcz_code: props.mcz_code ?? null,
    mcz_name: props.mcz_name ?? null,
    status: props.status ?? null,
    area: props.area ?? null,
    grid_ref: props.grid_ref ?? null,
    latitude: props.latitude ?? null,
    longitude: props.longitude ?? null,
    gis_date: props.gis_date ?? null,
  };
}

async function main(): Promise<void> {
  await setupSchema();

  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as GeoJsonFeatureCollection;
  const rows = payload.features
    .filter((feature) => feature.geometry && feature.geometry.type)
    .map((feature) => ({
      mpa_id: String(feature.id ?? feature.properties.mcz_code ?? feature.properties.mcz_name),
      name: String(feature.properties.mcz_name ?? feature.properties.mcz_code ?? "Unknown MPA"),
      designation_type: designationTypeFor(feature),
      source: SOURCE_NAME,
      status: feature.properties.status != null ? String(feature.properties.status) : null,
      metadata: buildMetadata(feature),
      geometry: feature.geometry,
    }));

  await upsertMpas(rows);
  console.log(`Imported ${rows.length} MPA feature(s) from ${SOURCE_NAME}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
