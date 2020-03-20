'use strict';
import { Options, MSALBasic } from './src/types';
import { MSAL } from './src/main';
import { mixin } from "./mixin";
export const msalMixin = mixin;

export default class MsalPlugin {
  static install(Vue: any, options: Options): void {
    Vue.prototype.$msal = new MsalPlugin(options, Vue);
  }

  constructor(options: Options, Vue: any = undefined) {
    const msal = new MSAL(options);

    if (Vue && options.framework && options.framework.globalMixin) {
      Vue.mixin(mixin);
    }

    const exposed: MSALBasic = {
      data: msal.data,
      signIn() { msal.signIn(); },
      async signOut() { await msal.signOut(); },
      isAuthenticated() { return msal.isAuthenticated(); },
      async acquireToken(request, disableTokenCache?) { return await msal.acquireToken(request, disableTokenCache); },
      async msGraph(endpoints, batchUrl) { return await msal.msGraph(endpoints, batchUrl) },
      saveCustomData(key: string, data: any) { msal.saveCustomData(key, data); }
    };

    return exposed;
  }
}
