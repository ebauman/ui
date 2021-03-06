import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';

@Injectable()
export class AppConfigService {
  private appConfig;

  constructor(private http: HttpClient) { }

  loadAppConfig() {
    return this.http.get('/config.json')
      .toPromise()
      .then(data => {
        this.appConfig = data;
      });
  }

  getLogo(logoPath: string) {
    const headers = new HttpHeaders();
    headers.set('Accept', '*')
    return this.http.get(logoPath, {headers, responseType: 'text'})
    .toPromise()
  }

  getConfig() {
    return this.appConfig;
  }
}
