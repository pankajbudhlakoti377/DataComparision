const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const SUPPORTED_EXTS = new Set(['.csv', '.xlsx', '.xls', '.xlsm', '.tsv', '.txt', '.zip']);

class AzureStorageService {
  constructor() {
    this.client = null;
    this.accountName = null;
    this.connectedAt = null;
    this._containerCache = null; // cached container list
  }

  // ─── Connect ───────────────────────────────────────────────────────────────
  async connect(connectionString, accountName, accountKey) {
    try {
      if (connectionString) {
        this.client = BlobServiceClient.fromConnectionString(connectionString);
        // Extract account name from connection string
        const match = connectionString.match(/AccountName=([^;]+)/i);
        this.accountName = match ? match[1] : 'unknown';
      } else if (accountName && accountKey) {
        const cred = new StorageSharedKeyCredential(accountName, accountKey);
        this.client = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, cred);
        this.accountName = accountName;
      } else {
        throw new Error('Provide either connection string or account name + key');
      }

      await this.client.getProperties();
      this.connectedAt = new Date().toISOString();
      this._containerCache = null;
      logger.info(`Azure Storage connected: ${this.accountName}`);
      return {
        success: true,
        accountName: this.accountName,
        connectedAt: this.connectedAt
      };
    } catch (err) {
      this.client = null;
      this.accountName = null;
      logger.error('Azure connection error:', err.message);
      throw new Error(`Azure connection failed: ${err.message}`);
    }
  }

  // ─── Connection info ───────────────────────────────────────────────────────
  getInfo() {
    return {
      connected: !!this.client,
      accountName: this.accountName,
      connectedAt: this.connectedAt
    };
  }

  // ─── List containers ───────────────────────────────────────────────────────
  async listContainers() {
    this.requireClient();
    if (this._containerCache) return this._containerCache;

    const containers = [];
    for await (const c of this.client.listContainers()) {
      containers.push({
        name: c.name,
        lastModified: c.properties.lastModified,
        publicAccess: c.properties.publicAccess || null
      });
    }
    this._containerCache = containers;
    return containers;
  }

  // ─── List top-level virtual folders + root files in a container ────────────
  // Uses hierarchy listing with '/' delimiter so we get folders cheaply.
  async listFolders(containerName, prefix = '') {
    this.requireClient();
    const cc = this.client.getContainerClient(containerName);
    const folders = [];
    const files   = [];
    const opts = { prefix };

    for await (const item of cc.listBlobsByHierarchy('/', opts)) {
      if (item.kind === 'prefix') {
        // Virtual folder
        const folderName = item.name.replace(/\/$/, '');
        const shortName  = folderName.split('/').pop();
        folders.push({ name: folderName, shortName, path: item.name });
      } else {
        // File at this level
        const ext = path.extname(item.name).toLowerCase();
        files.push({
          name: item.name,
          shortName: path.basename(item.name),
          size: item.properties.contentLength,
          lastModified: item.properties.lastModified,
          contentType: item.properties.contentType || '',
          ext,
          supported: SUPPORTED_EXTS.has(ext)
        });
      }
    }
    return { folders, files, prefix };
  }

  // ─── Get all blobs flat (legacy, used by load) ────────────────────────────
  async listBlobs(containerName, prefix = '', maxResults = 2000) {
    this.requireClient();
    const cc = this.client.getContainerClient(containerName);
    const blobs = [];
    for await (const blob of cc.listBlobsFlat({ prefix })) {
      const ext = path.extname(blob.name).toLowerCase();
      blobs.push({
        name: blob.name,
        shortName: path.basename(blob.name),
        size: blob.properties.contentLength,
        lastModified: blob.properties.lastModified,
        contentType: blob.properties.contentType || '',
        ext,
        supported: SUPPORTED_EXTS.has(ext)
      });
      if (blobs.length >= maxResults) break;
    }
    return blobs;
  }

  // ─── Count blobs in a container (for info display) ─────────────────────────
  async getBlobCount(containerName, prefix = '') {
    this.requireClient();
    const cc = this.client.getContainerClient(containerName);
    let count = 0;
    for await (const _ of cc.listBlobsFlat({ prefix })) count++;
    return count;
  }

  // ─── Download blob to local file ───────────────────────────────────────────
  async downloadBlob(containerName, blobName, localPath) {
    this.requireClient();
    const cc = this.client.getContainerClient(containerName);
    const bc = cc.getBlobClient(blobName);
    await fs.ensureDir(path.dirname(localPath));
    const resp = await bc.download();
    const ws = fs.createWriteStream(localPath);
    return new Promise((resolve, reject) => {
      resp.readableStreamBody.pipe(ws);
      ws.on('finish', () => resolve(localPath));
      ws.on('error', reject);
    });
  }

  // ─── Get blob properties without downloading ───────────────────────────────
  async getBlobProperties(containerName, blobName) {
    this.requireClient();
    const cc = this.client.getContainerClient(containerName);
    return await cc.getBlobClient(blobName).getProperties();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  isConnected() { return this.client !== null; }

  requireClient() {
    if (!this.client) throw new Error('Not connected to Azure Storage. Please connect first.');
  }

  disconnect() {
    this.client = null;
    this.accountName = null;
    this.connectedAt = null;
    this._containerCache = null;
  }
}

module.exports = new AzureStorageService();
