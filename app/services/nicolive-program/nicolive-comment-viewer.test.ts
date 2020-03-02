import { createSetupFunction } from 'util/test-setup';
import { Subject } from 'rxjs';
type NicoliveCommentViewerService = import('./nicolive-comment-viewer').NicoliveCommentViewerService;

const setup = createSetupFunction();

jest.mock('services/nicolive-program/nicolive-program', () => ({ NicoliveProgramStateService: {} }));

beforeEach(() => {
  jest.doMock('services/stateful-service');
  jest.doMock('util/injector');
});

afterEach(() => {
  jest.resetModules();
});

test('接続先情報が来たら接続する', () => {
  const stateChange = new Subject();
  const clientSubject = new Subject();
  jest.doMock('./MessageServerClient', () => ({
    ...jest.requireActual('./MessageServerClient'),
    MessageServerClient: class MessageServerClient {
      connect() {
        return clientSubject;
      }
      requestLatestMessages() {}
    },
  }));
  setup({ injectee: { NicoliveProgramService: { stateChange } } });

  const { NicoliveCommentViewerService } = require('./nicolive-comment-viewer');
  const instance = NicoliveCommentViewerService.instance as NicoliveCommentViewerService;

  expect(clientSubject.observers).toHaveLength(0);
  expect(stateChange.observers).toHaveLength(1);
  stateChange.next({ roomURL: 'https://example.com', roomThreadID: '175622' });
  expect(clientSubject.observers).toHaveLength(1);
});

test('接続先情報が欠けていたら接続しない', () => {
  const stateChange = new Subject();
  const clientSubject = new Subject();
  jest.doMock('./MessageServerClient', () => ({
    MessageServerClient: class MessageServerClient {
      connect() {
        return clientSubject;
      }
      requestLatestMessages() {}
    },
  }));
  setup({ injectee: { NicoliveProgramService: { stateChange } } });

  const { NicoliveCommentViewerService } = require('./nicolive-comment-viewer');
  const instance = NicoliveCommentViewerService.instance as NicoliveCommentViewerService;

  expect(clientSubject.observers).toHaveLength(0);
  expect(stateChange.observers).toHaveLength(1);
  stateChange.next({ roomURL: 'https://example.com' });
  expect(clientSubject.observers).toHaveLength(0);
});

test('/disconnectが流れてきたらunsubscribeする', () => {
  const stateChange = new Subject();
  const clientSubject = new Subject();
  jest.doMock('./MessageServerClient', () => {
    return {
      ...jest.requireActual('./MessageServerClient'),
      MessageServerClient: class MessageServerClient {
        connect() {
          return clientSubject;
        }
        requestLatestMessages() {}
      },
    };
  });
  jest.spyOn(window, 'setTimeout').mockImplementation(callback => callback() as any);
  setup({ injectee: { NicoliveProgramService: { stateChange } } });

  const { NicoliveCommentViewerService } = require('./nicolive-comment-viewer');
  const instance = NicoliveCommentViewerService.instance as NicoliveCommentViewerService;
  const unsubscribe = jest.fn();
  (instance as any).unsubscribe = unsubscribe;

  expect(clientSubject.observers).toHaveLength(0);
  expect(unsubscribe).toHaveBeenCalledTimes(0);
  stateChange.next({ roomURL: 'https://example.com', roomThreadID: '175622' });
  expect(clientSubject.observers).toHaveLength(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);

  // 通常コメントではunsubscribeしない
  clientSubject.next({ chat: { premium: 1, content: '/disconnect' } });
  expect(unsubscribe).toHaveBeenCalledTimes(1);

  clientSubject.next({ chat: { premium: 2, content: '/disconnect' } });
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

function connectionSetup() {
  const stateChange = new Subject();
  const clientSubject = new Subject();
  jest.doMock('./MessageServerClient', () => ({
    ...jest.requireActual('./MessageServerClient'),
    MessageServerClient: class MessageServerClient {
      connect() {
        return clientSubject;
      }
      requestLatestMessages() {}
    },
  }));
  setup({ injectee: { NicoliveProgramService: { stateChange } } });

  const { NicoliveCommentViewerService } = require('./nicolive-comment-viewer');
  const instance = NicoliveCommentViewerService.instance as NicoliveCommentViewerService;

  stateChange.next({ roomURL: 'https://example.com', roomThreadID: '175622' });

  return {
    instance,
    clientSubject,
  };
}

test('chatメッセージはstateに保持する', () => {
  jest.spyOn(Date, 'now').mockImplementation(() => 1582175622000);
  const { instance, clientSubject } = connectionSetup();

  clientSubject.next({
    chat: {
      content: 'yay',
    },
  });
  clientSubject.next({
    chat: {
      content: 'foo',
    },
  });

  // bufferTime tweaks
  clientSubject.complete();

  expect(instance.state.messages).toMatchInlineSnapshot(`
    Array [
      Object {
        "seqId": 0,
        "type": "normal",
        "value": Object {
          "content": "yay",
        },
      },
      Object {
        "seqId": 1,
        "type": "normal",
        "value": Object {
          "content": "foo",
        },
      },
      Object {
        "seqId": 2,
        "type": "n-air-emulated",
        "value": Object {
          "content": "サーバーとの接続が終了しました",
          "date": 1582175622,
        },
      },
    ]
  `);
});

test('接続エラー時にメッセージを表示する', () => {
  jest.spyOn(Date, 'now').mockImplementation(() => 1582175622000);
  const { instance, clientSubject } = connectionSetup();

  const error = new Error('yay');

  clientSubject.error(error);

  // bufferTime tweaks
  clientSubject.complete();

  expect(instance.state.messages).toMatchInlineSnapshot(`
                          Array [
                            Object {
                              "seqId": 0,
                              "type": "n-air-emulated",
                              "value": Object {
                                "content": "エラーが発生しました: yay",
                                "date": 1582175622,
                              },
                            },
                            Object {
                              "seqId": 1,
                              "type": "n-air-emulated",
                              "value": Object {
                                "content": "サーバーとの接続が終了しました",
                                "date": 1582175622,
                              },
                            },
                          ]
                `);
});

test('スレッドの参加失敗時にメッセージを表示する', () => {
  jest.spyOn(Date, 'now').mockImplementation(() => 1582175622000);
  const { instance, clientSubject } = connectionSetup();

  clientSubject.next({
    thread: {
      resultcode: 1,
    },
  });

  // bufferTime tweaks
  clientSubject.complete();

  expect(instance.state.messages).toMatchInlineSnapshot(`
        Array [
          Object {
            "seqId": 0,
            "type": "n-air-emulated",
            "value": Object {
              "content": "コメントの取得に失敗しました",
              "date": 1582175622,
            },
          },
          Object {
            "seqId": 1,
            "type": "n-air-emulated",
            "value": Object {
              "content": "サーバーとの接続が終了しました",
              "date": 1582175622,
            },
          },
        ]
    `);
});

test('スレッドからの追い出し発生時にメッセージを表示する', () => {
  jest.spyOn(Date, 'now').mockImplementation(() => 1582175622000);
  const { instance, clientSubject } = connectionSetup();

  clientSubject.next({
    leave_thread: {},
  });

  // bufferTime tweaks
  clientSubject.complete();

  expect(instance.state.messages).toMatchInlineSnapshot(`
        Array [
          Object {
            "seqId": 0,
            "type": "n-air-emulated",
            "value": Object {
              "content": "コメントの取得に失敗しました",
              "date": 1582175622,
            },
          },
          Object {
            "seqId": 1,
            "type": "n-air-emulated",
            "value": Object {
              "content": "サーバーとの接続が終了しました",
              "date": 1582175622,
            },
          },
        ]
    `);
});