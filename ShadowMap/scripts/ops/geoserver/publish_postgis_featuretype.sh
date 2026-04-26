#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/geoserver/publish_postgis_featuretype.sh [options]

Options:
  --base-url URL        GeoServer base URL, defaults to http://127.0.0.1:8080/geoserver
  --workspace NAME      Workspace, defaults to shadowmap
  --datastore NAME      Datastore, defaults to shadowmap_postgis
  --featuretype NAME    Published feature type name, defaults to basename of --native-name
  --native-name NAME    PostGIS table/view name, defaults to basename of --featuretype
  --title TEXT          Layer title
  --srs CODE            Declared SRS, defaults to EPSG:4326
  --bbox WEST,SOUTH,EAST,NORTH
  --username NAME       GeoServer admin username, defaults to admin
  --password VALUE      GeoServer admin password, defaults to geoserver
  --reload              Trigger REST reload after publish/update

Examples:
  ./scripts/ops/geoserver/publish_postgis_featuretype.sh \
    --featuretype buildings_us_lod1 \
    --native-name buildings_us_lod1 \
    --title "US Building Footprints (LoD1)" \
    --bbox=-180,17.5,-64,72.5 \
    --reload
EOF
}

base_url="${GEOSERVER_BASE_URL:-http://127.0.0.1:8080/geoserver}"
workspace="shadowmap"
datastore="shadowmap_postgis"
featuretype_name=""
native_name=""
title=""
srs="EPSG:4326"
bbox=""
username="${GEOSERVER_ADMIN_USER:-admin}"
password="${GEOSERVER_ADMIN_PASSWORD:-geoserver}"
reload_after="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)
      base_url="${2:-}"
      shift 2
      ;;
    --workspace)
      workspace="${2:-}"
      shift 2
      ;;
    --datastore)
      datastore="${2:-}"
      shift 2
      ;;
    --featuretype)
      featuretype_name="${2:-}"
      shift 2
      ;;
    --native-name)
      native_name="${2:-}"
      shift 2
      ;;
    --title)
      title="${2:-}"
      shift 2
      ;;
    --srs)
      srs="${2:-}"
      shift 2
      ;;
    --bbox)
      bbox="${2:-}"
      shift 2
      ;;
    --bbox=*)
      bbox="${1#*=}"
      shift 1
      ;;
    --username)
      username="${2:-}"
      shift 2
      ;;
    --password)
      password="${2:-}"
      shift 2
      ;;
    --reload)
      reload_after="true"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[Fatal] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "${featuretype_name}" ] && [ -z "${native_name}" ]; then
  echo "[Fatal] At least one of --featuretype or --native-name is required." >&2
  exit 1
fi

if [ -z "${featuretype_name}" ]; then
  featuretype_name="${native_name##*.}"
fi

if [ -z "${native_name}" ]; then
  native_name="${featuretype_name}"
fi

if [ -z "${title}" ]; then
  title="${featuretype_name}"
fi

if [ -n "${bbox}" ] && [[ ! "${bbox}" =~ ^-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?$ ]]; then
  echo "[Fatal] --bbox must look like WEST,SOUTH,EAST,NORTH" >&2
  exit 1
fi

base_url="${base_url%/}"
featuretypes_url="${base_url}/rest/workspaces/${workspace}/datastores/${datastore}/featuretypes"
featuretype_url="${featuretypes_url}/${featuretype_name}.xml"
reload_url="${base_url}/rest/reload"
auth="${username}:${password}"
payload_file="$(mktemp)"
response_file="$(mktemp)"
trap 'rm -f "${payload_file}" "${response_file}"' EXIT

minx=""
miny=""
maxx=""
maxy=""
if [ -n "${bbox}" ]; then
  IFS=',' read -r minx miny maxx maxy <<< "${bbox}"
fi

cat > "${payload_file}" <<EOF
<featureType>
  <name>${featuretype_name}</name>
  <nativeName>${native_name}</nativeName>
  <title>${title}</title>
  <enabled>true</enabled>
  <srs>${srs}</srs>
  <projectionPolicy>FORCE_DECLARED</projectionPolicy>
EOF

if [ -n "${bbox}" ]; then
  cat >> "${payload_file}" <<EOF
  <nativeBoundingBox>
    <minx>${minx}</minx>
    <maxx>${maxx}</maxx>
    <miny>${miny}</miny>
    <maxy>${maxy}</maxy>
    <crs>${srs}</crs>
  </nativeBoundingBox>
  <latLonBoundingBox>
    <minx>${minx}</minx>
    <maxx>${maxx}</maxx>
    <miny>${miny}</miny>
    <maxy>${maxy}</maxy>
    <crs>${srs}</crs>
  </latLonBoundingBox>
EOF
fi

cat >> "${payload_file}" <<'EOF'
</featureType>
EOF

status_code="$(curl -sS -o "${response_file}" -w '%{http_code}' -u "${auth}" "${featuretype_url}")"

if [ "${status_code}" = "200" ]; then
  curl -sS -o "${response_file}" -w '%{http_code}' \
    -u "${auth}" \
    -XPUT \
    -H 'Content-Type: text/xml' \
    --data-binary @"${payload_file}" \
    "${featuretype_url}" >/dev/null
  echo "[OK] Updated GeoServer featuretype ${workspace}:${featuretype_name}"
elif [ "${status_code}" = "404" ]; then
  create_code="$(curl -sS -o "${response_file}" -w '%{http_code}' \
    -u "${auth}" \
    -XPOST \
    -H 'Content-Type: text/xml' \
    --data-binary @"${payload_file}" \
    "${featuretypes_url}")"
  if [ "${create_code}" != "201" ]; then
    echo "[Fatal] Failed to create GeoServer featuretype ${workspace}:${featuretype_name} (HTTP ${create_code})" >&2
    cat "${response_file}" >&2
    exit 1
  fi
  echo "[OK] Created GeoServer featuretype ${workspace}:${featuretype_name}"
else
  echo "[Fatal] Could not inspect GeoServer featuretype ${workspace}:${featuretype_name} (HTTP ${status_code})" >&2
  cat "${response_file}" >&2
  exit 1
fi

verify_code="$(curl -sS -o "${response_file}" -w '%{http_code}' \
  "${base_url}/${workspace}/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=${workspace}:${featuretype_name}&maxFeatures=1&outputFormat=application/json")"

if [ "${verify_code}" != "200" ]; then
  echo "[Fatal] WFS verification failed for ${workspace}:${featuretype_name} (HTTP ${verify_code})" >&2
  cat "${response_file}" >&2
  exit 1
fi

if [ "${reload_after}" = "true" ]; then
  curl -sS -u "${auth}" -XPOST "${reload_url}" >/dev/null
  echo "[OK] Triggered GeoServer REST reload"
fi
