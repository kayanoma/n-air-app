import { StatefulService, mutation } from 'services/stateful-service';
import { NicoliveClient, CreateResult, EditResult, isOk } from './NicoliveClient';
import { ProgramSchedules } from './ResponseTypes';

type Schedules = ProgramSchedules['data'];
type Schedule = Schedules[0];
interface INicoliveProgramState {
  programID: string;
  status: 'reserved' | 'test' | 'onAir' | 'end';
  title: string;
  description: string;
  endTime: number;
  startTime: number;
  testStartTime: number;
  communityID: string;
  communityName: string;
  communitySymbol: string;
  viewers: number;
  comments: number;
  adPoint: number;
  giftPoint: number;
  /** TODO: 永続化 */
  autoExtensionEnabled: boolean;
}

export class NicoliveProgramService extends StatefulService<INicoliveProgramState> {
  static initialState: INicoliveProgramState = {
    programID: '',
    status: 'end',
    title: '',
    description: '',
    endTime: 0,
    startTime: 0,
    testStartTime: 0,
    communityID: '',
    communityName: '',
    communitySymbol: '',
    viewers: 0,
    comments: 0,
    adPoint: 0,
    giftPoint: 0,
    autoExtensionEnabled: false,
  };

  /**
   * 番組スケジュールから表示すべき番組を選ぶ
   * 1. テスト中または放送中の番組があればその番組を返す
   * 2. 予約番組があるなら最も近い予約番組を返す
   */
  static findSuitableProgram(schedules: Schedules): null | Schedule {
    // テスト中・放送中の番組があればそれで確定
    const now = Math.floor(Date.now() / 1000);
    const currentProgram = schedules.find(
      s => s.socialGroupId.startsWith('co') && s.testBeginAt <= now && now < s.onAirEndAt
    );
    if (currentProgram) return currentProgram;

    let nearestReservedProgram: null | Schedule = null;
    for (const s of schedules) {
      // ユーザー生放送以外は無視
      if (!s.socialGroupId.startsWith('co')) continue;

      // 一番近い予約放送を選ぶ
      if (!nearestReservedProgram || s.testBeginAt < nearestReservedProgram.testBeginAt) {
        nearestReservedProgram = s;
      }
    }
    return nearestReservedProgram;
  }

  client: NicoliveClient = new NicoliveClient();

  get hasProgram(): boolean {
    return Boolean(this.state.programID);
  }

  static isProgramExtendable(state: INicoliveProgramState): boolean {
    return state && state.status === 'onAir' && state.endTime - state.startTime < 6 * 60 * 60;
  }

  get isProgramExtendable(): boolean {
    return NicoliveProgramService.isProgramExtendable(this.state);
  }

  private setState(partialState: Partial<INicoliveProgramState>) {
    const nextState = { ...this.state, ...partialState };
    this.refreshStatisticsPolling(this.state, nextState);
    this.refreshProgramStatusTimer(this.state, nextState);
    this.refreshAutoExtensionTimer(this.state, nextState);
    this.SET_STATE(nextState);
  }

  @mutation()
  private SET_STATE(nextState: INicoliveProgramState): void {
    this.state = nextState;
  }

  async createProgram(): Promise<CreateResult> {
    const result = await this.client.createProgram();
    if (result === 'CREATED') {
      await this.fetchProgram();
    }
    return result;
  }

  async fetchProgram(): Promise<void> {
    const schedulesResponse = await this.client.fetchProgramSchedules();
    if (!isOk(schedulesResponse)) {
      console.warn(schedulesResponse.value.meta.errorCode);
      throw schedulesResponse.value;
    }

    const programSchedule = NicoliveProgramService.findSuitableProgram(schedulesResponse.value);

    if (!programSchedule) {
      if (this.state) {
        this.setState({ status: 'end' });
      }
      throw new Error('no suitable schedule');
    }
    const { nicoliveProgramId, socialGroupId } = programSchedule;

    const [programResponse, communityResponse] = await Promise.all([
      this.client.fetchProgram(nicoliveProgramId),
      this.client.fetchCommunity(socialGroupId),
    ]);
    if (!isOk(programResponse)) {
      console.warn(programResponse.value.meta.errorCode);
      throw programResponse.value;
    }
    if (!isOk(communityResponse)) {
      console.warn(communityResponse.value.meta.errorCode);
      throw communityResponse.value;
    }

    const community = communityResponse.value;
    const program = programResponse.value;

    this.setState({
      programID: nicoliveProgramId,
      status: program.status,
      title: program.title,
      description: program.description,
      startTime: program.beginAt,
      testStartTime: programSchedule.testBeginAt,
      endTime: program.endAt,
      communityID: socialGroupId,
      communityName: community.name,
      communitySymbol: community.thumbnailUrl.small,
    });
  }

  async refreshProgram(): Promise<void> {
    const programResponse = await this.client.fetchProgram(this.state.programID);
    if (!isOk(programResponse)) {
      console.warn(programResponse.value.meta.errorCode);
      throw programResponse.value;
    }

    const program = programResponse.value;

    this.setState({
      status: program.status,
      title: program.title,
      description: program.description,
      startTime: program.beginAt,
      endTime: program.endAt,
    });
  }

  async editProgram(): Promise<EditResult> {
    const result = await this.client.editProgram(this.state.programID);
    if (result === 'EDITED') {
      await this.refreshProgram();
    }
    return result;
  }

  async startProgram(): Promise<void> {
    const result = await this.client.startProgram(this.state.programID);
    if (isOk(result)) {
      const endTime = result.value.end_time;
      const startTime = result.value.start_time;
      this.setState({ status: 'onAir', endTime, startTime });
      return;
    }

    throw result.value;
  }

  async endProgram(): Promise<void> {
    const result = await this.client.endProgram(this.state.programID);
    if (isOk(result)) {
      const endTime = result.value.end_time;
      this.setState({ status: 'end', endTime });
      return;
    }

    throw result.value;
  }

  toggleAutoExtension() {
    const autoExtensionEnabled = !this.state.autoExtensionEnabled;
    this.setState({ autoExtensionEnabled });
  }

  async extendProgram(): Promise<void> {
    const result = await this.client.extendProgram(this.state.programID);
    if (isOk(result)) {
      this.setState({
        endTime: result.value.end_time,
      });
      return;
    }

    throw result.value;
  }

  private statsTimer: number = 0;
  refreshStatisticsPolling(prevState: INicoliveProgramState, nextState: INicoliveProgramState): void {
    const onInitialize = !prevState;
    const hasNextProgram = Boolean(nextState.programID);
    const programUpdated = onInitialize || prevState.programID !== nextState.programID;
    const nextStatusIsOnAir = nextState.status === 'onAir';
    const statusUpdated = onInitialize || prevState.status !== nextState.status;

    if (hasNextProgram && nextStatusIsOnAir && (programUpdated || statusUpdated)) {
      clearInterval(this.statsTimer);
      this.updateStatistics(nextState.programID); // run and forget
      this.statsTimer = window.setInterval((id: string) => this.updateStatistics(id), 60 * 1000, nextState.programID);
    } else if (!nextStatusIsOnAir) {
      clearInterval(this.statsTimer);
    }
  }

  updateStatistics(programID: string): void {
    this.client
      .fetchStatistics(programID)
      .then(res => {
        if (isOk(res)) {
          this.setState({
            viewers: res.value.watchCount,
            comments: res.value.commentCount,
          });
        }
      })
      .catch(() => null);
    this.client
      .fetchNicoadStatistics(programID)
      .then(res => {
        if (isOk(res)) {
          this.setState({
            adPoint: res.value.totalAdPoint,
            giftPoint: res.value.totalGiftPoint,
          });
        }
      })
      .catch(() => null);
  }

  async sendOperatorComment(text: string, isPermanent: boolean): Promise<void> {
    const result = await this.client.sendOperatorComment(this.state.programID, { text, isPermanent });
    if (!isOk(result)) throw result.value;
  }

  static TIMER_PADDING_SECONDS = 3;
  static REFRESH_TARGET_TIME_TABLE = {
    reserved: 'testStartTime',
    test: 'startTime',
    onAir: 'endTime',
  };
  private refreshProgramTimer = 0;
  refreshProgramStatusTimer(prevState: INicoliveProgramState, nextState: INicoliveProgramState): void {
    const now = Date.now();
    const onInitialize = !prevState;
    const statusUpdated = onInitialize || prevState.status !== nextState.status;

    const status = nextState.status;
    /** 放送状態が変化しなかった前提で、放送状態が次に変化するであろう時刻 */
    const prevTargetTime: number = nextState[NicoliveProgramService.REFRESH_TARGET_TIME_TABLE[status]];
    const nextTargetTime: number = nextState[NicoliveProgramService.REFRESH_TARGET_TIME_TABLE[status]];

    // 次に放送状態が変化する予定の時刻（より少し後）に放送情報を更新するタイマーを仕込む
    if (statusUpdated || prevTargetTime !== nextTargetTime) {
      clearTimeout(this.refreshProgramTimer);
      this.refreshProgramTimer = window.setTimeout(() => {
        this.refreshProgram();
      }, (nextTargetTime + NicoliveProgramService.TIMER_PADDING_SECONDS) * 1000 - now);
      return;
    }
  }

  private autoExtensionTimer = 0;
  refreshAutoExtensionTimer(prevState: INicoliveProgramState, nextState: INicoliveProgramState): void {
    const now = Date.now();
    const onInitialize = !prevState;
    const endTimeUpdated = onInitialize || prevState.endTime !== nextState.endTime;

    /** 更新前の状態でタイマーが動作しているべきか */
    const prev =
      !onInitialize && prevState.autoExtensionEnabled && NicoliveProgramService.isProgramExtendable(prevState);
    /** 更新後の状態でタイマーが動作しているべきか */
    const next = nextState.autoExtensionEnabled && NicoliveProgramService.isProgramExtendable(nextState);

    // 動作すべき状態になる OR 終了時刻が変わったら再設定
    if ((!prev && next) || (next && endTimeUpdated)) {
      clearTimeout(this.autoExtensionTimer);
      this.autoExtensionTimer = window.setTimeout(() => {
        this.extendProgram();
      }, (nextState.endTime - 5 * 60) * 1000 - now);
      console.log(
        '自動延長タイマーが（再）設定されました ',
        Math.floor(((nextState.endTime - 5 * 60) * 1000 - now) / 1000),
        '秒後に自動延長します'
      );
      return;
    }

    // 動作すべきでない状態になるなら解除
    if (prev && !next) {
      clearTimeout(this.autoExtensionTimer);
      console.log('自動延長タイマーが解除されました');
    }
  }
}
