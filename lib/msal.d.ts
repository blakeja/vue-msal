import Vue from 'vue';
import { MSALBasic } from './src/types';

declare module 'vue/types/vue' {
  interface Vue {
    $msal: MSALBasic;
  }
}