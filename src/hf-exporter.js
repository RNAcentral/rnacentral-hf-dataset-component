import { createRepo, uploadFiles, whoAmI, oauthLoginUrl } from '@huggingface/hub';

class HFDatasetExporter extends HTMLElement {
  constructor() {
    super();

    // Initialize state
    this.accessToken = null;
    this.parquetJobId = null;
    this.readmeJobId = null;
    this.parquetReady = false;
    this.readmeReady = false;
    this.exportStatus = 'idle';
    this.uploadProgress = 0;
    this.retryCount = 0;
    this.maxRetries = 3;  // Allow retries for transient OAuth failures
    this.pollInterval = null;
    this.oauthPopup = null;

    // Attach shadow DOM
    this.attachShadow({ mode: 'open' });

    // Render initial UI
    this.render();
  }

  connectedCallback() {
    // Parse configuration attributes
    this.config = {
      exportApiUrl: this.getAttribute('export-api-url') || '',
      hfClientId: this.getAttribute('hf-client-id') || '',
      redirectUri: this.getAttribute('redirect-uri') || window.location.origin + '/oauth/callback',
      datasetDescription: this.getAttribute('dataset-description') || 'Dataset exported from RNAcentral',
      license: this.getAttribute('license') || 'cc0-1.0',
      pollIntervalMs: parseInt(this.getAttribute('poll-interval')) || 5000,
      oauthScopes: this.getAttribute('oauth-scopes') || 'openid profile email read-repos write-repos manage-repos',
    };

    // Listen for OAuth callback messages
    window.addEventListener('message', this.handleOAuthCallback.bind(this));

    // Add event listeners
    this.setupEventListeners();
  }

  disconnectedCallback() {
    // Cleanup
    if (this._pollIntervals) {
      this._pollIntervals.forEach(id => clearInterval(id));
    }
    if (this.oauthPopup && !this.oauthPopup.closed) {
      this.oauthPopup.close();
    }
    window.removeEventListener('message', this.handleOAuthCallback.bind(this));
  }

  setupEventListeners() {
    const exportBtn = this.shadowRoot.getElementById('export-btn');
    const datasetNameInput = this.shadowRoot.getElementById('dataset-name');

    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.startExport());
    }

    if (datasetNameInput) {
      datasetNameInput.addEventListener('input', (e) => {
        this.validateDatasetName(e.target.value);
      });
    }
  }

  validateDatasetName(name) {
    // HuggingFace dataset names must be lowercase alphanumeric with hyphens/underscores
    const isValid = /^[a-z0-9-_]+$/.test(name);
    const input = this.shadowRoot.getElementById('dataset-name');
    const btn = this.shadowRoot.getElementById('export-btn');

    if (isValid || name === '') {
      input.style.borderColor = '';
      btn.disabled = !name;
    } else {
      input.style.borderColor = 'red';
      btn.disabled = true;
    }

    return isValid;
  }

  async startExport(isRetry = false) {
    const datasetName = this.shadowRoot.getElementById('dataset-name').value.trim();

    if (!datasetName) {
      this.updateStatus('error', 'Please enter a dataset name');
      return;
    }

    if (!this.validateDatasetName(datasetName)) {
      this.updateStatus('error', 'Dataset name must be lowercase alphanumeric with hyphens or underscores');
      return;
    }

    this.datasetName = datasetName;

    // Only reset retry count if this is a fresh start, not a retry
    if (!isRetry) {
      this.retryCount = 0;
    }

    try {
      // Step 1: Authenticate with HuggingFace
      await this.ensureAuthenticated();

      // Step 2: Submit export job
      await this.submitExportJob();

      // Step 3: Poll for completion and get download URL
      await this.pollExportStatus();

      // Step 4: Create HuggingFace dataset and upload
      await this.createAndUploadDataset();

      // Success!
      this.updateStatus('success', `Dataset created successfully!`);
      this.showDatasetLink();

    } catch (error) {
      console.error('Export failed:', error);
      this.handleError(error);
    }
  }

  async ensureAuthenticated() {
    // Check if we already have a token
    if (this.accessToken) {
      try {
        const user = await whoAmI({ credentials: { accessToken: this.accessToken } });
        this.username = user.name;
        this.updateStatus('authenticating', `Authenticated as ${this.username}`);
        return;
      } catch (error) {
        // Token is invalid, need to re-authenticate
        this.accessToken = null;
      }
    }

    // Start OAuth flow
    await this.startOAuthFlow();
  }

  async startOAuthFlow() {
    this.updateStatus('authenticating', 'Opening HuggingFace login...');

    const scopes = this.config.oauthScopes;
    const state = this.generateRandomState();

    console.log('OAuth: Requesting scopes:', scopes);

    // Store state for validation
    this.oauthState = state;

    // Build OAuth URL
    const authUrl = await oauthLoginUrl({
      clientId: this.config.hfClientId,
      redirectUrl: this.config.redirectUri,
      scopes: scopes,  // Note: 'scopes' (plural) not 'scope'
      state: state,
    });

    console.log('OAuth: Authorization URL:', authUrl);

    // Open popup window
    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    this.oauthPopup = window.open(
      authUrl,
      'HuggingFace OAuth',
      `width=${width},height=${height},left=${left},top=${top}`
    );

    // Wait for OAuth callback
    return new Promise((resolve, reject) => {
      this.oauthResolve = resolve;
      this.oauthReject = reject;

      // Set a timeout for OAuth flow (5 minutes)
      const oauthTimeout = setTimeout(() => {
        clearInterval(checkClosed);
        if (!this.accessToken) {
          console.error('OAuth timeout: User did not complete authorization within 5 minutes');
          if (this.oauthPopup && !this.oauthPopup.closed) {
            this.oauthPopup.close();
          }
          reject(new Error('OAuth timeout - please try again'));
        }
      }, 5 * 60 * 1000); // 5 minutes

      // Check if popup was closed without completing OAuth
      const checkClosed = setInterval(() => {
        if (this.oauthPopup && this.oauthPopup.closed) {
          clearInterval(checkClosed);
          clearTimeout(oauthTimeout);

          // Give a brief moment for localStorage to be set
          setTimeout(() => {
            // Check localStorage fallback if postMessage didn't work
            const storedCallback = localStorage.getItem('hf_oauth_callback');
            if (storedCallback) {
              console.log('Main: Found OAuth callback in localStorage');
              try {
                const callbackData = JSON.parse(storedCallback);
                localStorage.removeItem('hf_oauth_callback'); // Clean up

                // Process the callback data as if it came via postMessage
                this.handleOAuthCallback({
                  origin: window.location.origin,
                  data: {
                    code: callbackData.code,
                    state: callbackData.state
                  }
                });
              } catch (error) {
                console.error('Failed to process localStorage callback:', error);
                if (!this.accessToken) {
                  reject(new Error('Authentication cancelled'));
                }
              }
            } else if (!this.accessToken) {
              reject(new Error('Authentication cancelled'));
            }
          }, 500); // Wait 500ms for localStorage to be set
        }
      }, 1000);
    });
  }

  async handleOAuthCallback(event) {
    // Accept messages from same origin (for localhost development and production)
    const redirectOrigin = new URL(this.config.redirectUri).origin;
    const currentOrigin = window.location.origin;

    // Debug logging to help troubleshoot origin issues
    console.log('OAuth callback received:', {
      messageOrigin: event.origin,
      redirectOrigin: redirectOrigin,
      currentOrigin: currentOrigin
    });

    // For localhost development, accept both localhost and 127.0.0.1
    const isLocalhost = event.origin === 'http://localhost:8000' ||
                        event.origin === 'http://127.0.0.1:8000' ||
                        event.origin === 'https://localhost:8000' ||
                        event.origin === 'https://127.0.0.1:8000';

    const isSameOrigin = event.origin === redirectOrigin || event.origin === currentOrigin;

    // Check both redirect URI origin, current page origin, or localhost variants
    if (!isSameOrigin && !isLocalhost) {
      console.warn('Ignoring postMessage from unexpected origin:', event.origin);
      return;
    }

    let { code, state, error } = event.data;

    // HuggingFace returns state as an object with nested state property
    // Handle both formats: string or object with state property
    if (typeof state === 'object' && state !== null && state.state) {
      console.log('Main: State is object, extracting nested state');
      state = state.state;
    }

    console.log('Main: Received state:', state);
    console.log('Main: Expected state:', this.oauthState);
    console.log('Main: States match?', state === this.oauthState);

    if (error) {
      this.oauthReject(new Error(`OAuth error: ${error}`));
      return;
    }

    if (state !== this.oauthState) {
      console.error('Main: State mismatch! Received:', state, 'Expected:', this.oauthState);
      this.oauthReject(new Error('Invalid OAuth state'));
      return;
    }

    if (!code) {
      return;
    }

    // Exchange code for token
    try {
      const tokenResponse = await this.exchangeCodeForToken(code);
      this.accessToken = tokenResponse.access_token;

      // Get user info
      const user = await whoAmI({ credentials: { accessToken: this.accessToken } });
      this.username = user.name;

      this.updateStatus('authenticating', `Authenticated as ${this.username}`);

      // Close popup
      if (this.oauthPopup && !this.oauthPopup.closed) {
        this.oauthPopup.close();
      }

      this.oauthResolve();

    } catch (error) {
      this.oauthReject(error);
    }
  }

  async exchangeCodeForToken(code) {
    // Exchange authorization code for access token
    const tokenUrl = 'https://huggingface.co/oauth/token';

    // Get the code_verifier that was stored by oauthLoginUrl
    const codeVerifier = localStorage.getItem('huggingface.co:oauth:code_verifier');
    if (!codeVerifier) {
      console.error('Token exchange: No code_verifier found in localStorage!');
      throw new Error('PKCE code_verifier not found');
    }

    console.log('Token exchange: Sending request to HuggingFace');
    console.log('Token exchange: redirect_uri:', this.config.redirectUri);
    console.log('Token exchange: client_id:', this.config.hfClientId);
    console.log('Token exchange: code_verifier found:', !!codeVerifier);

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.hfClientId,
        code_verifier: codeVerifier,
      }),
    });

    console.log('Token exchange: Response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Token exchange: Error response:', errorText);
      throw new Error(`Token exchange failed (${response.status}): ${errorText || response.statusText}`);
    }

    const tokenData = await response.json();
    console.log('Token exchange: Success! Received access token');

    // Clean up the code_verifier from localStorage for security
    localStorage.removeItem('huggingface.co:oauth:code_verifier');
    localStorage.removeItem('huggingface.co:oauth:nonce');

    return tokenData;
  }

  async submitExportJob() {
    this.updateStatus('exporting', 'Submitting export jobs...');

    const sourceApiUrl = this.getAttribute('source-api-url') || '';

    const [parquetResponse, readmeResponse] = await Promise.all([
      fetch(this.config.exportApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_url: sourceApiUrl, data_type: 'parquet' }),
      }),
      fetch(this.config.exportApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_url: sourceApiUrl, data_type: 'huggingface' }),
      }),
    ]);

    if (!parquetResponse.ok) {
      throw new Error(`Parquet export submission failed: ${parquetResponse.statusText}`);
    }
    if (!readmeResponse.ok) {
      throw new Error(`README export submission failed: ${readmeResponse.statusText}`);
    }

    const parquetData = await parquetResponse.json();
    const readmeData = await readmeResponse.json();

    this.parquetJobId = parquetData.task_id;
    this.readmeJobId = readmeData.task_id;
    this.parquetReady = false;
    this.readmeReady = false;

    this.updateStatus('exporting', `Export jobs submitted (parquet: ${this.parquetJobId}, readme: ${this.readmeJobId})`);
  }

  async pollExportStatus() {
    const pollJob = (jobId, dataType) => {
      return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
          try {
            const url = this.getDownloadUrl(jobId, dataType);
            const response = await fetch(url);

            if (!response.ok) {
              throw new Error(`Status check failed for ${dataType}: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type');

            if (contentType && contentType.includes('application/json')) {
              const status = await response.json();
              const progress = status.progress_ids || 0;
              const total = status.hit_count || 100;
              const percentage = Math.round((progress / total) * 100);

              if (dataType === 'parquet') {
                this.updateStatus('exporting', `Parquet export progress: ${percentage}%`);
                this.uploadProgress = percentage;
              }
            } else {
              // Job is complete — do NOT consume the body, the HF library will fetch it
              clearInterval(interval);
              resolve();
            }
          } catch (error) {
            clearInterval(interval);
            reject(error);
          }
        }, this.config.pollIntervalMs);

        // Store interval so it can be cleared on disconnect
        if (!this._pollIntervals) this._pollIntervals = [];
        this._pollIntervals.push(interval);
      });
    };

    await Promise.all([
      pollJob(this.parquetJobId, 'parquet').then(() => { this.parquetReady = true; }),
      pollJob(this.readmeJobId, 'huggingface').then(() => { this.readmeReady = true; }),
    ]);

    this.updateStatus('exporting', 'Export complete, preparing upload...');
  }

  getDownloadUrl(jobId, dataType) {
    const baseUrl = this.config.exportApiUrl.replace('/submit', '');
    return `${baseUrl}/download/${jobId}/${dataType}`;
  }

  async createAndUploadDataset() {
    this.updateStatus('uploading', 'Creating dataset on HuggingFace...');

    const repoName = `${this.username}/${this.datasetName}`;

    // Create the dataset repository
    try {
      await createRepo({
        repo: {
          type: 'dataset',
          name: repoName,
        },
        credentials: { accessToken: this.accessToken },
        license: this.config.license,
      });

      this.updateStatus('uploading', 'Dataset repository created');
    } catch (error) {
      // Repository might already exist
      if (!error.message.includes('already exists')) {
        throw error;
      }
      this.updateStatus('uploading', 'Using existing dataset repository');
    }

    const parquetUrl = this.getDownloadUrl(this.parquetJobId, 'parquet');
    const readmeUrl = this.getDownloadUrl(this.readmeJobId, 'huggingface');

    this.updateStatus('uploading', 'Uploading files to HuggingFace...');

    await uploadFiles({
      repo: {
        type: 'dataset',
        name: repoName,
      },
      credentials: { accessToken: this.accessToken },
      files: [
        { path: 'data.parquet', content: new URL(parquetUrl) },
        { path: 'README.md', content: new URL(readmeUrl) },
      ],
    });

    this.datasetUrl = `https://huggingface.co/datasets/${repoName}`;
  }

  async handleError(error) {
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      this.updateStatus('error', `Error: ${error.message}. Retrying (${this.retryCount}/${this.maxRetries})...`);

      // Wait before retrying (exponential backoff)
      await this.sleep(Math.pow(2, this.retryCount) * 1000);

      // Retry from the appropriate step
      if (!this.accessToken) {
        return this.startExport(true);
      } else if (!this.parquetJobId || !this.readmeJobId) {
        return this.submitExportJob();
      } else if (!this.parquetReady || !this.readmeReady) {
        return this.pollExportStatus();
      } else {
        return this.createAndUploadDataset();
      }
    } else {
      this.updateStatus('error', `Failed after ${this.maxRetries} attempts: ${error.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  generateRandomState() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  updateStatus(type, message) {
    this.exportStatus = type;
    const statusEl = this.shadowRoot.getElementById('status-message');
    const progressBar = this.shadowRoot.getElementById('progress-bar');
    const exportBtn = this.shadowRoot.getElementById('export-btn');

    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status ${type}`;
    }

    if (progressBar) {
      if (type === 'exporting' || type === 'uploading') {
        progressBar.style.display = 'block';
        progressBar.value = this.uploadProgress;
      } else {
        progressBar.style.display = 'none';
      }
    }

    if (exportBtn) {
      exportBtn.disabled = (type === 'exporting' || type === 'uploading' || type === 'authenticating');
    }
  }

  showDatasetLink() {
    const linkContainer = this.shadowRoot.getElementById('dataset-link');
    if (linkContainer && this.datasetUrl) {
      linkContainer.innerHTML = `
        <a href="${this.datasetUrl}" target="_blank" rel="noopener noreferrer">
          View dataset on HuggingFace →
        </a>
      `;
      linkContainer.style.display = 'block';
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
          max-width: 500px;
          padding: 20px;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          background: #ffffff;
        }

        h3 {
          margin: 0 0 16px 0;
          font-size: 18px;
          color: #1a1a1a;
        }

        .form-group {
          margin-bottom: 16px;
        }

        label {
          display: block;
          margin-bottom: 6px;
          font-size: 14px;
          font-weight: 500;
          color: #333;
        }

        input[type="text"] {
          width: 100%;
          padding: 8px 12px;
          font-size: 14px;
          border: 1px solid #ccc;
          border-radius: 4px;
          box-sizing: border-box;
          font-family: 'Monaco', 'Menlo', monospace;
        }

        input[type="text"]:focus {
          outline: none;
          border-color: #ff9d00;
        }

        button {
          width: 100%;
          padding: 10px 16px;
          font-size: 14px;
          font-weight: 600;
          color: white;
          background: linear-gradient(135deg, #ff9d00 0%, #ff7b00 100%);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          transition: opacity 0.2s;
        }

        button:hover:not(:disabled) {
          opacity: 0.9;
        }

        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .status {
          margin-top: 16px;
          padding: 12px;
          border-radius: 4px;
          font-size: 13px;
          display: none;
        }

        .status.idle {
          display: none;
        }

        .status.authenticating,
        .status.exporting,
        .status.uploading {
          display: block;
          background: #e3f2fd;
          color: #1565c0;
          border: 1px solid #90caf9;
        }

        .status.success {
          display: block;
          background: #e8f5e9;
          color: #2e7d32;
          border: 1px solid #81c784;
        }

        .status.error {
          display: block;
          background: #ffebee;
          color: #c62828;
          border: 1px solid #ef9a9a;
        }

        progress {
          width: 100%;
          height: 8px;
          margin-top: 12px;
          display: none;
          border-radius: 4px;
        }

        progress::-webkit-progress-bar {
          background-color: #e0e0e0;
          border-radius: 4px;
        }

        progress::-webkit-progress-value {
          background: linear-gradient(135deg, #ff9d00 0%, #ff7b00 100%);
          border-radius: 4px;
        }

        #dataset-link {
          margin-top: 16px;
          display: none;
        }

        #dataset-link a {
          display: inline-block;
          padding: 8px 16px;
          background: #f5f5f5;
          color: #ff9d00;
          text-decoration: none;
          border-radius: 4px;
          font-weight: 500;
          font-size: 14px;
        }

        #dataset-link a:hover {
          background: #eeeeee;
        }

        .help-text {
          font-size: 12px;
          color: #666;
          margin-top: 4px;
        }
      </style>

      <div>
        <h3>Export to HuggingFace Dataset</h3>

        <div class="form-group">
          <label for="dataset-name">Dataset Name</label>
          <input
            type="text"
            id="dataset-name"
            placeholder="my-dataset-name"
            autocomplete="off"
          />
          <div class="help-text">Lowercase letters, numbers, hyphens, and underscores only</div>
        </div>

        <button id="export-btn">Export to HuggingFace</button>

        <progress id="progress-bar" max="100" value="0"></progress>

        <div id="status-message" class="status idle"></div>

        <div id="dataset-link"></div>
      </div>
    `;
  }
}

// Register the custom element
customElements.define('hf-dataset-exporter', HFDatasetExporter);
