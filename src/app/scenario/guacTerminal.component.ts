import {
  Component,
  ViewChild,
  ElementRef,
  OnInit,
  Input,
  OnChanges,
  ViewEncapsulation,
} from '@angular/core';
import { CtrService } from './ctr.service';
import { CodeExec } from './CodeExec';
import { ShellService } from '../services/shell.service';
import { JwtHelperService } from '@auth0/angular-jwt';
import { environment } from 'src/environments/environment';
import Guacamole from 'guacamole-common-js';
import GuacMouse from './guacLibs/GuacMouse';
import clipboard from './guacLibs/clipboard';
import states from './guacLibs/states';
//import {Modal} from '@/components/Modal'

@Component({
  selector: 'guacTerminal',
  templateUrl: './guacTerminal.component.html',
  styleUrls: ['guacTerminal.component.scss'],
  encapsulation: ViewEncapsulation.None,
})
export class GuacTerminalComponent implements OnChanges {
  @Input()
  vmid: string;

  @Input()
  vmname: string;

  @Input()
  endpoint: string;

  public optimalWidth: number = 1024;
  public optimalHeight: number = 744;

  public connected = false;
  public display: any;
  public client: Guacamole.Client;
  public keyboard: Guacamole.Keyboard;
  public mouse: Guacamole.Mouse;
  public connectionState = states.IDLE;
  public errorMessage?: string;
  public arguments: any = {};

  constructor(
    public ctrService: CtrService,
    public shellService: ShellService,
    public jwtHelper: JwtHelperService,
  ) {
    Guacamole.Mouse = GuacMouse.mouse;
  }

  @ViewChild('guacTerminal', { static: true }) terminalDiv: ElementRef;
  @ViewChild('viewport', { static: true }) viewport: ElementRef;

  queryObj() {
    return {
      width: this.optimalWidth,
      height: this.optimalHeight,
      auth: this.jwtHelper.tokenGetter(),
    };
  }

  buildQuery() {
    const queryString = [];
    for (const [k, v] of Object.entries(this.queryObj())) {
      if (v) {
        queryString.push(`${k}=${encodeURIComponent(v)}`);
      }
    }
    return queryString.join('&');
  }

  connect() {
    if (
      !this.endpoint.startsWith('wss://') &&
      !this.endpoint.startsWith('ws://')
    ) {
      if (environment.server.startsWith('https')) {
        this.endpoint = 'wss://' + this.endpoint;
      } else {
        this.endpoint = 'ws://' + this.endpoint;
      }
    }
    let tunnel;
    tunnel = new Guacamole.WebSocketTunnel(
      this.endpoint + '/guacShell/' + this.vmid + '/connect',
    );
    if (this.client) {
      this.display.scale(0);
      this.uninstallKeyboard();
    }
    this.client = new Guacamole.Client(tunnel);
    clipboard.install(this.client);
    tunnel.onerror = (status) => {
      // eslint-disable-next-line no-console
      console.error(`Tunnel failed ${JSON.stringify(status)}`);
      this.shellService.setStatus(this.vmname, 'Tunnel Error');
      this.connectionState = states.TUNNEL_ERROR;
    };
    tunnel.onstatechange = (state) => {
      switch (state) {
        // Connection is being established
        case Guacamole.Tunnel.State.CONNECTING:
          this.connectionState = states.CONNECTING;
          break;
        // Connection is established / no longer unstable
        case Guacamole.Tunnel.State.OPEN:
          this.connectionState = states.CONNECTED;
          break;
        // Connection is established but misbehaving
        case Guacamole.Tunnel.State.UNSTABLE:
          // TODO
          break;
        // Connection has closed
        case Guacamole.Tunnel.State.CLOSED:
          this.connectionState = states.DISCONNECTED;
          break;
      }
    };

    this.client.onstatechange = (clientState) => {
      console.log('state: ' + clientState);
      switch (clientState) {
        case 0:
          this.connectionState = states.IDLE;
          this.shellService.setStatus(this.vmname, 'Idle');
          break;
        case 1:
          // connecting ignored for some reason?
          this.shellService.setStatus(this.vmname, 'Connecting...');
          break;
        case 2:
          this.connectionState = states.WAITING;
          this.shellService.setStatus(this.vmname, 'Waiting...');
          break;
        case 3:
          this.connectionState = states.CONNECTED;
          this.shellService.setStatus(this.vmname, 'Connected');
          window.addEventListener('resize', () => {
            this.resize();
          });
          this.viewport.nativeElement.addEventListener('mouseenter', () => {
            this.resize();
          });
          clipboard.setRemoteClipboard(this.client);
          this.resize();
          break;
        case 4:
          this.shellService.setStatus(this.vmname, 'Disconnecting...');
          break;
        case 5:
          // Client error
          this.shellService.setStatus(this.vmname, 'Disconnected');
          break;
      }
    };
    this.client.onerror = (error) => {
      this.client.disconnect();
      // eslint-disable-next-line no-console
      console.error(`Client error ${JSON.stringify(error)}`);
      this.shellService.setStatus(this.vmname, 'Client Error');
      this.errorMessage = error.message;
      this.connectionState = states.CLIENT_ERROR;
    };
    this.client.onsync = () => {};

    // Test for argument mutability whenever an argument value is received
    this.client.onargv = (stream, mimetype, name) => {
      if (mimetype !== 'text/plain') return;
      const reader = new Guacamole.StringReader(stream);
      // Assemble received data into a single string
      let value = '';
      reader.ontext = (text) => {
        value += text;
      };
      // Test mutability once stream is finished, storing the current value for the argument only if it is mutable
      reader.onend = () => {
        const stream = this.client.createArgumentValueStream(
          'text/plain',
          name,
        );
        stream.onack = (status) => {
          if (status.isError()) {
            // ignore reject
            return;
          }
          this.arguments[name] = value;
        };
      };
    };
    this.client.onclipboard = clipboard.onClipboard;
    this.display = this.client.getDisplay();
    const displayElm = this.terminalDiv.nativeElement;
    displayElm.appendChild(this.display.getElement());
    displayElm.addEventListener(
      'contextmenu',
      (e: {
        stopPropagation: () => void;
        preventDefault: () => void;
        returnValue: boolean;
      }) => {
        e.stopPropagation();
        if (e.preventDefault) {
          e.preventDefault();
        }
        e.returnValue = false;
      },
    );

    let optimalResolution = this.getOptimalResolution();
    this.optimalHeight = optimalResolution?.height ?? 1024;
    this.optimalWidth = optimalResolution?.width ?? 744;
    this.client.connect(this.buildQuery());

    this.ctrService.getCodeStream().subscribe((c: CodeExec) => {
      if (!c) {
        return;
      }
      // if the code exec is target at us,execute it
      if (c.target.toLowerCase() == this.vmname.toLowerCase()) {
        // break up the code by lines
        var codeArray: string[] = c.code.split('\n');
        let command = '';
        //Append a carriage return and newline to every command.
        codeArray.forEach((s: string) => {
          command += s + '\r\n';
        });
        this.send(command);
      }
    });

    window.onunload = () => this.client.disconnect();
    this.mouse = new Guacamole.Mouse(displayElm);
    // Hide software cursor when mouse leaves display
    this.mouse.onmouseout = () => {
      if (!this.display) return;
      this.display.showCursor(false);
    };
    // allows focusing on the display div so that keyboard doesn't always go to session
    displayElm.onclick = () => {
      displayElm.focus();
    };
    displayElm.onfocus = () => {
      displayElm.className = 'focus';
    };
    displayElm.onblur = () => {
      displayElm.className = '';
    };
    this.keyboard = new Guacamole.Keyboard(displayElm);
    this.installKeyboard();
    this.mouse.onmousedown =
      this.mouse.onmouseup =
      this.mouse.onmousemove =
        (mousestate) => {
          this.handleMouseState(mousestate);
        };
    setTimeout(() => {
      this.resize();
      displayElm.focus();
    }, 1000); // $nextTick wasn't enough
  }

  installKeyboard() {
    this.keyboard.onkeydown = (keysym) => {
      this.client.sendKeyEvent(1, keysym);
    };
    this.keyboard.onkeyup = (keysym) => {
      this.client.sendKeyEvent(0, keysym);
    };
  }

  uninstallKeyboard() {
    this.keyboard.onkeydown = this.keyboard.onkeyup = () => {};
  }

  async sleep(time: number) {
    return await new Promise((resolve) => setTimeout(resolve, time));
  }

  /*
   *  Send a command to the server
   *
   *  What this actually does is:
   *  1. store the current remote clipboard
   *  2. copy the command to the remote clipboard
   *  3. paste the command using LEFT_CONTROL and V
   *  4. copy the old remote clipboard back to the server
   *
   *  The sleep function is needed in order for Guacamole to fullfill all key pressed events,
   *  otherwise it will sometimes not recognize the key as pressed, or paste the wrong clipboard.
   */
  async send(cmd: string) {
    if (!this.client) {
      return;
    }

    //LEFT_CONTROL and V as of https://github.com/apache/guacamole-client/blob/master/guacamole-common-js/src/main/webapp/modules/Keyboard.js
    //As Defined in the X11 Window System Protocol: https://www.cl.cam.ac.uk/~mgk25/ucs/keysymdef.h
    let pasteKeys = [0xffe3, 0x76];

    let remoteClipboard = {
      type: clipboard.remoteClipboard.type,
      data: clipboard.remoteClipboard.data,
    };
    this.copy({ type: 'text/plain', data: cmd });

    //Press Keys to paste clipboard, and release them afterwards
    //sendKeyEvent(1, X) = press, sendKeyEvent(0,X) = release
    for (let i: 0 | 1 = 1; i >= 0; i = 0) {
      await this.sleep(20);
      this.client.sendKeyEvent(i, pasteKeys[0]);
      this.client.sendKeyEvent(i, pasteKeys[1]);
    }

    await this.sleep(50);
    this.copy(remoteClipboard);
  }

  copy(data: { type: string; data: any }) {
    if (!this.client) {
      return;
    }
    clipboard.cache = {
      type: data.type,
      data: data.data,
    };
    clipboard.setRemoteClipboard(this.client);
  }

  handleMouseState = (mouseState: Guacamole.Mouse.State) => {
    let scale = this.display.getScale();
    const scaledMouseState = Object.assign({}, mouseState, {
      x: mouseState.x / scale,
      y: mouseState.y / scale,
    });
    this.client.sendMouseState(scaledMouseState);
  };

  ngOnChanges() {
    if (!this.connected && this.endpoint != null) {
      this.connected = true;
      this.connect();
    }
  }

  getOptimalResolution() {
    const elm = this.viewport.nativeElement;
    if (!elm || !elm.offsetWidth) {
      // resize is being called on the hidden window
      return;
    }
    let pixelDensity = window.devicePixelRatio || 1;
    const width = elm.clientWidth * pixelDensity;
    const height = elm.clientHeight * pixelDensity;

    return { width: width, height: height };
  }

  resize() {
    const elm = this.viewport.nativeElement;
    if (!elm || !elm.offsetWidth) {
      // resize is being called on the hidden window
      return;
    }
    let optimalResolution = this.getOptimalResolution();
    this.optimalHeight = optimalResolution?.height ?? 1024;
    this.optimalWidth = optimalResolution?.width ?? 744;

    if (
      this.display.getWidth() !== optimalResolution?.width ||
      this.display.getHeight() !== optimalResolution?.height
    ) {
      this.client.sendSize(
        optimalResolution?.width ?? 1024,
        optimalResolution?.height ?? 744,
      );
    }
    // setting timeout so display has time to get the correct size
    setTimeout(() => {
      const scale = Math.min(
        elm.clientWidth / Math.max(this.display.getWidth(), 1),
        elm.clientHeight / Math.max(this.display.getHeight(), 1),
      );
      this.display.scale(scale);
    }, 100);
  }

  onResize() {
    this.resize();
  }
}
