import * as React from 'react';
import * as ReactDOM from 'react-dom';
import WindowProvider from '../../components/window_provider';
import Container from './container';
import { IntlProvider } from '../../components/intl';

class Root extends WindowProvider<{}, {}> {
  onReject = () => {
    this.params.accept = false;
    this.close();
  };

  onApprove = () => {
    this.params.accept = true;
    this.close();
  };

  render() {
    return (
      <IntlProvider>
        <Container
          onReject={this.onReject}
          onApprove={this.onApprove}
          origin={this.params.origin}
          pin={this.params.pin}
        />
      </IntlProvider>
    );
  }
}

ReactDOM.render(
  <Root />,
  document.getElementById('root'),
);
