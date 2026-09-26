package com.example.bapp.webapp;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(UpdaterPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
