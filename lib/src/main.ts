import _ from "lodash";
import { default as axios, Method } from "axios";
import { UserAgentApplicationExtended } from "./UserAgentApplicationExtended";
import {
  Auth,
  Request,
  Graph,
  CacheOptions,
  Options,
  DataObject,
  CallbackQueueObject,
  AuthError,
  AuthResponse,
  MSALBasic,
  GraphEndpoints,
  GraphDetailedObject,
  CategorizedGraphRequests,
  EndpointRequest,
  EndpointResponse
} from './types';

export class MSAL implements MSALBasic {
  // eslint-disable-next-line
  private lib: any;

  private tokenExpirationTimer: undefined | number = undefined;

  public data: DataObject = {
    isAuthenticated: false,
    accessToken: '',
    user: {},
    graph: {},
    custom: {}
  };

  public callbackQueue: CallbackQueueObject[] = [];

  private readonly auth: Auth = {
    clientId: '',
    tenantId: 'common',
    tenantName: 'login.microsoftonline.com',
    validateAuthority: true,
    redirectUri: window.location.href,
    postLogoutRedirectUri: window.location.href,
    navigateToLoginRequestUrl: true,
    requireAuthOnInitialize: false,
    autoRefreshToken: true,
    // eslint-disable-next-line
    onAuthentication: (error, response) => { },
    // eslint-disable-next-line
    onToken: (error, response) => { },
    // eslint-disable-next-line
    beforeSignOut: () => { }
  };

  private readonly cache: CacheOptions = {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: true
  };

  private readonly request: Request = {
    scopes: ["user.read"]
  };

  private readonly graph: Graph = {
    callAfterInit: false,
    endpoints: { profile: '/me' },
    baseUrl: 'https://graph.microsoft.com/v1.0',
    // eslint-disable-next-line
    onResponse: (response) => { }
  };

  constructor(private readonly options: Options) {
    if (!options.auth.clientId) {
      throw new Error('auth.clientId is required');
    }

    this.auth = Object.assign(this.auth, options.auth);
    this.cache = Object.assign(this.cache, options.cache);
    this.request = Object.assign(this.request, options.request);
    this.graph = Object.assign(this.graph, options.graph);

    this.lib = new UserAgentApplicationExtended({
      auth: {
        clientId: this.auth.clientId,
        authority: `https://${this.auth.tenantName}/${this.auth.tenantId}`,
        validateAuthority: this.auth.validateAuthority,
        redirectUri: this.auth.redirectUri,
        postLogoutRedirectUri: this.auth.postLogoutRedirectUri,
        navigateToLoginRequestUrl: this.auth.navigateToLoginRequestUrl
      },
      cache: this.cache,
      system: options.system
    });

    this.getSavedCallbacks();

    this.executeCallbacks();

    // Register Callbacks for redirect flow
    this.lib.handleRedirectCallback((error: AuthError, response: AuthResponse) => {
      this.saveCallback('auth.onAuthentication', error, response);
    });

    if (this.auth.requireAuthOnInitialize) {
      this.signIn()
    }

    this.data.isAuthenticated = this.isAuthenticated();

    if (this.data.isAuthenticated) {
      this.data.user = this.lib.getAccount();
      this.acquireToken().then(() => {
        if (this.graph.callAfterInit) {
          this.initialMSGraphCall();
        }
      });
    }

    this.getStoredCustomData();
  }

  signIn(): void {
    if (!this.lib.isCallback(window.location.hash) && !this.lib.getAccount()) {
      // request can be used for login or token request, however in more complex situations this can have diverging options
      this.lib.loginRedirect(this.request);
    }
  }

  async signOut(): Promise<void> {
    if (this.options.auth.beforeSignOut) {
      await this.options.auth.beforeSignOut(this);
    }

    this.lib.logout();
  }

  isAuthenticated(): boolean {
    return !this.lib.isCallback(window.location.hash) && !!this.lib.getAccount();
  }

  async acquireToken(request = this.request, disableTokenCache?: boolean): Promise<string | boolean> {
    try {
      //Always start with acquireTokenSilent to obtain a token in the signed in user from cache
      const response = await this.lib.acquireTokenSilent(request);

      if (disableTokenCache === undefined && !disableTokenCache && this.data.accessToken !== response.accessToken) {
        this.setAccessToken(response.accessToken, response.expiresOn, response.scopes);
        this.saveCallback('auth.onToken', null, response);
      }

      return response.accessToken;
    } catch (error) {
      // Upon acquireTokenSilent failure (due to consent or interaction or login required ONLY)
      // Call acquireTokenRedirect
      if (this.requiresInteraction(error.errorCode)) {
        this.lib.acquireTokenRedirect(request); //acquireTokenPopup
      } else if (disableTokenCache === undefined && !disableTokenCache) {
        this.saveCallback('auth.onToken', error, null);
      }

      return false;
    }
  }

  private setAccessToken(accessToken: string, expiresOn: Date, scopes: string[]): void {
    this.data.accessToken = accessToken;
    const expirationOffset = this.lib.config.system.tokenRenewalOffsetSeconds * 1000;
    const expiration = expiresOn.getTime() - (new Date()).getTime() - expirationOffset;

    if (this.tokenExpirationTimer) {
      clearTimeout(this.tokenExpirationTimer);
    }

    this.tokenExpirationTimer = window.setTimeout(() => {
      if (this.auth.autoRefreshToken) {
        this.acquireToken({ scopes });
      } else {
        this.data.accessToken = '';
      }
    }, expiration)
  }

  private requiresInteraction(errorCode: string): boolean {
    if (!errorCode || !errorCode.length) {
      return false;
    }

    return errorCode === "consent_required" ||
      errorCode === "interaction_required" ||
      errorCode === "login_required";
  }

  // MS GRAPH
  async initialMSGraphCall(): Promise<void> {
    const { onResponse: callback } = this.graph;
    const initEndpoints = this.graph.endpoints;

    if (typeof initEndpoints === 'object' && !_.isEmpty(initEndpoints)) {
      const resultsObj = {};
      const forcedIds: string[] = [];

      try {
        const endpoints: { [id: string]: GraphDetailedObject & { force?: boolean } } = {};

        for (const id in initEndpoints) {
          endpoints[id] = this.getEndpointObject(initEndpoints[id]);

          if (endpoints[id].force) {
            forcedIds.push(id);
          }
        }

        let storedIds: string[] = [];
        let storedData = this.lib.store.getItem(`msal.msgraph-${this.data.accessToken}`);

        if (storedData) {
          storedData = JSON.parse(storedData);
          storedIds = Object.keys(storedData);
          Object.assign(resultsObj, storedData);
        }

        const { singleRequests, batchRequests } = this.categorizeRequests(endpoints, _.difference(storedIds, forcedIds));

        const singlePromises = singleRequests.map(async endpoint => {
          const res = {};
          res[endpoint.id as string] = await this.msGraph(endpoint);
          return res;
        });

        const batchPromises = Object.keys(batchRequests).map(key => {
          const batchUrl = (key === 'default') ? undefined : key;
          return this.msGraph(batchRequests[key], batchUrl);
        });

        const mixedResults = await Promise.all([...singlePromises, ...batchPromises]);
        mixedResults.map((res) => {
          for (const key in res) {
            res[key] = res[key].body;
          }

          Object.assign(resultsObj, res);
        });

        const resultsToSave = { ...resultsObj };
        forcedIds.map(id => delete resultsToSave[id]);

        this.lib.store.setItem(`msal.msgraph-${this.data.accessToken}`, JSON.stringify(resultsToSave));

        this.data.graph = resultsObj;
      } catch (error) {
        console.error(error);
      }

      if (callback) {
        this.saveCallback('graph.onResponse', this.data.graph);
      }
    }
  }

  async msGraph(endpoints: GraphEndpoints, batchUrl: string | undefined = undefined): Promise<any> {
    if (Array.isArray(endpoints)) {
      return await this.executeBatchRequest(endpoints, batchUrl);
    } else {
      return await this.executeSingleRequest(endpoints);
    }
  }

  private async executeBatchRequest(endpoints: Array<string | GraphDetailedObject>, batchUrl = this.graph.baseUrl): Promise<any> {
    const requests: EndpointRequest[] = endpoints.map((endpoint, index) => this.createRequest(endpoint, index));

    const { data } = await axios.request({
      url: `${batchUrl}/$batch`,
      method: 'POST' as Method,
      data: { requests: requests },
      headers: { Authorization: `Bearer ${this.data.accessToken}` },
      responseType: 'json'
    });

    let result = {};

    data.responses.map(response => {
      const key = response.id;
      delete response.id;
      return result[key] = response
    });

    // Format result
    const keys = Object.keys(result);

    const numKeys = keys.sort().filter((key, index) => {
      if (key.search('defaultID-') === 0) {
        key = key.replace('defaultID-', '');
      }

      return parseInt(key) === index;
    });

    if (numKeys.length === keys.length) {
      result = _.values(result);
    }

    return result;
  }

  private async executeSingleRequest(endpoint: string | GraphDetailedObject): Promise<EndpointResponse> {
    const request: EndpointRequest = this.createRequest(endpoint);

    if (request.url.search('http') !== 0) {
      request.url = this.graph.baseUrl + request.url;
    }

    const res = await axios.request(_.defaultsDeep(request, {
      url: request.url,
      method: request.method as Method,
      responseType: 'json',
      headers: { Authorization: `Bearer ${this.data.accessToken}` }
    }));

    return {
      status: res.status,
      headers: res.headers,
      body: res.data
    }
  }

  private createRequest(endpoint: string | GraphDetailedObject, index = 0): EndpointRequest {
    const request: EndpointRequest = {
      url: '',
      method: 'GET',
      id: `defaultID-${index}`
    };

    endpoint = this.getEndpointObject(endpoint);

    if (endpoint.url) {
      Object.assign(request, endpoint);
    } else {
      throw ({ error: 'invalid endpoint', endpoint: endpoint });
    }

    return request;
  }

  private categorizeRequests(endpoints: { [id: string]: GraphDetailedObject & { batchUrl?: string } }, excludeIds: string[]): CategorizedGraphRequests {
    const res: CategorizedGraphRequests = {
      singleRequests: [],
      batchRequests: {}
    };

    for (const key in endpoints) {
      const endpoint = {
        id: key,
        ...endpoints[key]
      };

      if (!_.includes(excludeIds, key)) {
        if (endpoint.batchUrl) {
          const { batchUrl } = endpoint;
          delete endpoint.batchUrl;

          // eslint-disable-next-line
          if (!res.batchRequests.hasOwnProperty(batchUrl)) {
            res.batchRequests[batchUrl] = [];
          }

          res.batchRequests[batchUrl].push(endpoint);
        } else {
          res.singleRequests.push(endpoint);
        }
      }
    }

    return res;
  }

  private getEndpointObject(endpoint: string | GraphDetailedObject): GraphDetailedObject {
    if (typeof endpoint === "string") {
      endpoint = { url: endpoint }
    }

    if (typeof endpoint === "object" && !endpoint.url) {
      throw new Error('invalid endpoint url')
    }

    return endpoint;
  }

  // CUSTOM DATA
  saveCustomData(key: string, data: any): void {
    // eslint-disable-next-line
    if (!this.data.custom.hasOwnProperty(key)) {
      this.data.custom[key] = null;
    }

    this.data.custom[key] = data;
    this.storeCustomData();
  }

  private storeCustomData(): void {
    if (!_.isEmpty(this.data.custom)) {
      this.lib.store.setItem('msal.custom', JSON.stringify(this.data.custom));
    } else {
      this.lib.store.removeItem('msal.custom');
    }
  }

  private getStoredCustomData(): void {
    let customData = {};
    const customDataStr = this.lib.store.getItem('msal.custom');

    if (customDataStr) {
      customData = JSON.parse(customDataStr);
    }

    this.data.custom = customData;
  }

  // CALLBACKS
  private saveCallback(callbackPath: string, ...args: any[]): void {
    if (_.get(this.options, callbackPath)) {
      const callbackQueueObject: CallbackQueueObject = {
        id: _.uniqueId(`cb-${callbackPath}`),
        callback: callbackPath,
        arguments: args
      };

      this.callbackQueue.push(callbackQueueObject);
      this.storeCallbackQueue();
      this.executeCallbacks([callbackQueueObject]);
    }
  }

  private getSavedCallbacks(): void {
    const callbackQueueStr = this.lib.store.getItem('msal.callbackqueue');

    if (callbackQueueStr) {
      this.callbackQueue = [...this.callbackQueue, ...JSON.parse(callbackQueueStr)];
    }
  }

  private async executeCallbacks(callbacksToExec: CallbackQueueObject[] = this.callbackQueue): Promise<void> {
    if (callbacksToExec.length) {
      for (const i in callbacksToExec) {
        const cb = callbacksToExec[i];
        const callback = _.get(this.options, cb.callback);

        try {
          await callback(this, ...cb.arguments);

          _.remove(this.callbackQueue, function (currentCb) {
            return cb.id === currentCb.id;
          });

          this.storeCallbackQueue();
        } catch (e) {
          console.warn(`Callback '${cb.id}' failed with error: `, e.message);
        }
      }
    }
  }

  private storeCallbackQueue(): void {
    if (this.callbackQueue.length) {
      this.lib.store.setItem('msal.callbackqueue', JSON.stringify(this.callbackQueue));
    } else {
      this.lib.store.removeItem('msal.callbackqueue');
    }
  }
}