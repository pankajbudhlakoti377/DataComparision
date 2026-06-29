# Data Comparison Tool v2.0

A production-ready full-stack tool for comparing Internal vs. Vendor data files with intelligent column mapping, diff detection, and report generation.

## Features

- **File Upload**: Excel (.xlsx, .xls, .xlsm), CSV, TSV, ZIP with drag & drop
- **Azure Blob Storage**: Connect and browse containers directly
- **Intelligent Column Mapping**: Auto-suggest with fuzzy matching
- **Comparison Engine**: Key-based matching, field-level diff detection, duplicate detection
- **Results**: Paginated detail table, SKU analysis, field differences, category & brand breakdowns
- **Reports**: Excel (multi-sheet), CSV (per section), PDF download center
- **Real-time**: SSE activity log, job progress tracking
- **Performance**: Async processing, chunked comparison for large files

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start the server
npm start
```

Open http://localhost:3000 in your browser.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| PORT | 3000 | Server port |
| UPLOAD_DIR | ./uploads | File upload directory |
| OUTPUT_DIR | ./outputs | Generated reports directory |
| MAX_FILE_SIZE_MB | 200 | Max upload size in MB |
| AZURE_CONNECTION_STRING | — | Default Azure connection string |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | /api/files/upload/:side | Upload file (internal/vendor) |
| GET | /api/files/info/:side | Get file info |
| POST | /api/comparison/run | Start comparison job |
| GET | /api/comparison/job/:id | Poll job status |
| GET | /api/comparison/results | Get paginated results |
| POST | /api/comparison/suggest-mappings | Auto-suggest column mappings |
| POST | /api/azure/connect | Connect to Azure Storage |
| GET | /api/azure/containers | List containers |
| GET | /api/azure/blobs/:container | List blobs |
| POST | /api/azure/load | Load blob into session |
| POST | /api/export/generate | Generate report |
| GET | /api/export/download/:filename | Download report |
| GET | /api/activity/stream | SSE event stream |

## Tech Stack

- **Backend**: Node.js, Express 4, multer, xlsx, csv-parser, pdfkit, @azure/storage-blob
- **Frontend**: Vanilla JS, Chart.js, Tabler Icons
- **Caching**: node-cache (session store, job manager)
- **Logging**: Winston + custom SSE activity logger
