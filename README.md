# RNAcentral HuggingFace Dataset Exporter

A Web Component that exports RNAcentral search results to HuggingFace datasets. It authenticates with HuggingFace via OAuth, submits export jobs to the RNAcentral export service, and streams the resulting parquet data and README directly to a HuggingFace dataset repository.

## Quick Start

### 1. Install and build

```bash
npm install
npm run build
```

This creates `dist/bundle.js`.

### 2. Set up HuggingFace OAuth

1. Register an OAuth application at https://huggingface.co/settings/connected-applications
2. Set the redirect URI to match your deployment (e.g. `https://yoursite.com/oauth-callback.html`)
3. Copy the Client ID

### 3. Add to your page

```html
<hf-dataset-exporter
  export-api-url="https://export.rnacentral.org/submit"
  source-api-url="https://www.ebi.ac.uk/ebisearch/ws/rest/rnacentral?query=*"
  hf-client-id="your_client_id_here"
  redirect-uri="https://yoursite.com/oauth-callback.html"
  dataset-description="RNA sequences exported from RNAcentral"
  license="cc0-1.0"
></hf-dataset-exporter>

<script src="dist/bundle.js"></script>
```

The OAuth callback page must extract `code` and `state` from the URL and send them back to the opener via `postMessage`. See `oauth-callback.html` for a reference implementation.

## Configuration

### Required Attributes

| Attribute | Description |
|-----------|-------------|
| `export-api-url` | RNAcentral export service submit endpoint |
| `source-api-url` | EBI Search API URL (passed to the export service) |
| `hf-client-id` | HuggingFace OAuth Client ID |

### Optional Attributes

| Attribute | Default | Description |
|-----------|---------|-------------|
| `redirect-uri` | `{origin}/oauth/callback` | OAuth redirect URI (must match your HF OAuth app settings) |
| `dataset-description` | `Dataset exported from RNAcentral` | Description for the dataset README |
| `license` | `cc0-1.0` | Dataset license identifier |
| `poll-interval` | `5000` | Polling interval in milliseconds |

## How It Works

1. User enters a dataset name
2. Component authenticates with HuggingFace via OAuth popup
3. Two export jobs are submitted in parallel to the RNAcentral export service: one for **parquet** data, one for the **README**
4. Both jobs are polled until complete
5. A dataset repository is created on HuggingFace
6. The export service download URLs are passed directly to the HuggingFace hub library, which streams the files (`data.parquet` and `README.md`) to the repository without loading them into browser memory

## Export Service API

The component expects the RNAcentral export service to provide:

### Submit — `POST {export-api-url}`

Two jobs are submitted with different `data_type` values:

```json
{ "api_url": "https://...", "data_type": "parquet" }
{ "api_url": "https://...", "data_type": "huggingface" }
```

Response: `{ "task_id": "abc123" }`

### Download/Status — `GET {base_url}/download/{task_id}/{data_type}`

Returns JSON while the job is running:

```json
{ "progress_ids": 500, "hit_count": 1000 }
```

Returns the file (parquet or README) with appropriate `Content-Type` when complete.

Both endpoints must support **HEAD** requests with `Content-Length` headers. `Accept-Ranges: bytes` is recommended for large parquet files to enable streaming uploads.

### CORS

The export service must allow cross-origin requests:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

## Development

```bash
npm install
npm run build        # production build
npm run dev          # development build with watch
npm start            # serve on http://localhost:8000
```

Then open `http://localhost:8000/example.html`.

## License

ISC
