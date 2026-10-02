import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { message: string }> {
  state = { message: '' };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  render() {
    return this.state.message ? (
      <div className="boot-screen">
        <h1>화면을 표시하지 못했습니다.</h1>
        <p>{this.state.message}</p>
        <p>저장된 프로젝트는 유지됩니다. 다시 열어 복구할 수 있습니다.</p>
        <button className="button primary" onClick={() => location.reload()}>
          작업실 다시 열기
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
